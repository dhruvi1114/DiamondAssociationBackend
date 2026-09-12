import { prisma } from '@db/prisma';
import { asDate, resolvePeriod, type DashboardFilters } from '@modules/dashboard/dashboard.filters';
import { kpi, kpiNoDelta, type KpiValue } from '@modules/dashboard/dashboard.kpi';
import * as repo from '@modules/dashboard/dashboard.repository';

/**
 * The work-queue counts for the admin landing page (A-02, AJ-1).
 *
 * Every number here is computed in SQL and never in the browser — the module's
 * definition of done says so, and the reason is that two places counting
 * "renewals due" eventually disagree about whether a lapsed one counts.
 *
 * A tile the caller cannot act on is not counted. The dashboard is
 * permission-scoped by design: a queue a role cannot work is absent from the
 * screen, so counting it would be work done for a number nobody sees.
 */

/** What a caller may be told, keyed by the permission that reveals it. */
const TILES = {
  applications: { permission: 'application.view', count: repo.openApplications },
  // Same permission as `applications` above, deliberately: this is the other
  // half of the Member Requests queue (waiting on the applicant, not staff),
  // so anyone who can see one tile can see the other.
  applicationsActionNeeded: {
    permission: 'application.view',
    count: repo.actionNeededApplications,
  },
  documents: { permission: 'document.verify', count: repo.pendingDocuments },
  memberDocuments: { permission: 'document.verify', count: repo.pendingMemberDocuments },
  changeRequests: { permission: 'member.approve_change', count: repo.pendingChangeRequests },
  invoices: { permission: 'invoice.view', count: repo.overdueInvoices },
  renewals: { permission: 'renewal.view', count: repo.renewalsDue },
  notifications: { permission: 'notification.view', count: repo.failedNotifications },
} as const;

export type TileKey = keyof typeof TILES;

export type DashboardSummary = Partial<Record<TileKey, number>>;

/**
 * A 60-second cache, keyed by the exact set of tiles asked for.
 *
 * The landing page is the most-hit screen in the app and its numbers are counts
 * of a queue, not a bank balance — a minute stale is invisible to the person
 * reading it and saves six queries on every navigation back to the dashboard.
 *
 * Keyed by tile set rather than by admin: two ACCOUNTS admins ask the same
 * question and should share the answer, while an ADMIN asks a wider one and must
 * not be served the narrower cached reply.
 */
const CACHE_MS = 60_000;

const cache = new Map<string, { at: number; value: DashboardSummary }>();

/** Exposed for tests and for the settings screen's "recalculate now". */
export const clearDashboardCache = (): void => cache.clear();

export const getSummary = async (
  permissions: string[],
  isSuperAdmin: boolean,
): Promise<DashboardSummary> => {
  const keys = (Object.keys(TILES) as TileKey[]).filter(
    // Mirrors the backend's own authorize(): a super admin bypasses every check,
    // and that bypass is what makes their dashboard show all six.
    (key) => isSuperAdmin || permissions.includes(TILES[key].permission),
  );

  const cacheKey = keys.join(',');
  const hit = cache.get(cacheKey);

  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.value;
  }

  /*
    Run in parallel. Six independent counts against six different tables have no
    reason to wait for each other, and the slowest one sets the response time
    either way.
  */
  const counted = await Promise.all(keys.map((key) => TILES[key].count(prisma)));
  const value: DashboardSummary = Object.fromEntries(
    keys.map((key, index) => [key, counted[index]]),
  );

  cache.set(cacheKey, { at: Date.now(), value });

  return value;
};

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

export interface NextEventDto {
  id: string;
  title: string;
  start_at: string;
  city: string | null;
  /** NULL when the event has no seat limit. */
  capacity: number | null;
  booked: number;
}

export interface DashboardKpis {
  period: { from: string; to: string; compare_to: DashboardFilters['compare_to'] };
  active_members: KpiValue;
  overdue_amount: KpiValue;
  /** How many invoices that overdue money sits on — the tile's second line. */
  overdue_invoice_count: number;
  collected: KpiValue;
  open_applications: KpiValue;
  /** Open applications older than 14 days. */
  stale_applications: number;
  /** NULL when nothing is scheduled — an absence, not a zero. */
  next_event: NextEventDto | null;
}

/**
 * A 15-minute cache, keyed by the filters that produced the answer.
 *
 * Longer than the work queue's 60 seconds because these are different figures
 * doing a different job: a queue count is a to-do list and goes stale in
 * minutes, while "active members this month" moves a handful of times a week.
 * Fifteen minutes of staleness is invisible on a trend and saves five queries
 * on every visit.
 *
 * Keyed on the resolved window rather than the raw filters, so `last_30d` asked
 * twice in one afternoon is one cache entry, and a `custom` range that happens
 * to match a preset shares its answer.
 */
const KPI_CACHE_MS = 15 * 60_000;

const kpiCache = new Map<string, { at: number; value: DashboardKpis }>();

export const clearKpiCache = (): void => kpiCache.clear();

export const getKpis = async (filters: DashboardFilters): Promise<DashboardKpis> => {
  const period = resolvePeriod(filters);
  const window = {
    from: asDate(period.from),
    to: asDate(period.to),
    prevFrom: asDate(period.prevFrom),
    prevTo: asDate(period.prevTo),
  };

  const key = [window.from, window.to, window.prevFrom, window.prevTo, filters.compare_to].join(
    '|',
  );
  const hit = kpiCache.get(key);

  if (hit && Date.now() - hit.at < KPI_CACHE_MS) {
    return hit.value;
  }

  /*
    Five independent queries against five different tables. Run together: none
    of them needs another's answer, and the slowest sets the response time
    whether they wait for each other or not.
  */
  const [members, overdue, overdueCount, received, applications, event] = await Promise.all([
    repo.activeMembers(prisma, window),
    repo.overdueAmount(prisma, window),
    repo.overdueInvoiceCount(prisma, window),
    repo.collected(prisma, window),
    repo.applicationBacklog(prisma),
    repo.nextEvent(prisma),
  ]);

  const value: DashboardKpis = {
    period: { from: window.from, to: window.to, compare_to: filters.compare_to },
    active_members: kpi(members.current, members.previous, filters.compare_to),
    overdue_amount: kpi(overdue.current, overdue.previous, filters.compare_to),
    overdue_invoice_count: overdueCount,
    collected: kpi(received.current, received.previous, filters.compare_to),
    // No delta: this is a queue as it stands right now, and comparing it to last
    // month's queue tells nobody anything they can act on.
    open_applications: kpiNoDelta(applications.open),
    stale_applications: applications.stale,
    next_event: event
      ? {
          id: event.id.toString(),
          title: event.title,
          start_at: event.start_at.toISOString(),
          city: event.city,
          capacity: event.capacity,
          booked: event.booked,
        }
      : null,
  };

  kpiCache.set(key, { at: Date.now(), value });

  return value;
};

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export interface DashboardCharts {
  membership_trend: repo.TrendPoint[];
  revenue: { grain: 'day' | 'week' | 'month'; buckets: repo.RevenueBucket[] } & repo.RevenueTotals;
  top_members: { company_name: string; days: number; share_pct: number }[];
  /** Everything outside the top slice, so the donut sums to the whole. */
  other_share_pct: number;
  upcoming_events: NextEventDto[];
}

/**
 * How finely to bucket the revenue chart.
 *
 * Chosen from the window's length rather than fixed: a year in daily buckets is
 * 365 bars nobody can read, and a week in monthly buckets is one bar that says
 * nothing. The thresholds are where a bar chart stops being scannable.
 */
const grainFor = (from: Date, to: Date): 'day' | 'week' | 'month' => {
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);

  if (days <= 31) return 'day';
  if (days <= 120) return 'week';

  return 'month';
};

/**
 * Fifteen minutes, keyed on the resolved window.
 *
 * Longer than the work queue's minute because these are the expensive queries —
 * twelve months of grouped rows and a per-member tenure sum — and they answer a
 * question that moves by the week. The same key shape as the KPI cache, so a
 * period asked twice in an afternoon is one computation for both halves of the
 * screen.
 */
const CHART_CACHE_MS = 15 * 60_000;

const chartCache = new Map<string, { at: number; value: DashboardCharts }>();

export const clearChartCache = (): void => chartCache.clear();

export const getCharts = async (filters: DashboardFilters): Promise<DashboardCharts> => {
  const period = resolvePeriod(filters);
  const window = {
    from: asDate(period.from),
    to: asDate(period.to),
    prevFrom: asDate(period.prevFrom),
    prevTo: asDate(period.prevTo),
  };

  const key = [window.from, window.to].join('|');
  const hit = chartCache.get(key);

  if (hit && Date.now() - hit.at < CHART_CACHE_MS) {
    return hit.value;
  }

  const grain = grainFor(period.from, period.to);

  const [trend, buckets, totals, top, totalDays, events] = await Promise.all([
    // Always twelve months, whatever the filter says: a membership trend read
    // over one month is two points and a straight line between them, which is
    // not a trend. The filter scopes the money, not the history.
    repo.membershipTrend(prisma, 12),
    repo.revenueBuckets(prisma, window, grain),
    repo.revenueTotals(prisma, window),
    repo.topMembersByTenure(prisma, 5),
    repo.totalTenureDays(prisma),
    repo.upcomingEvents(prisma, 3),
  ]);

  const share = (days: number): number =>
    totalDays > 0 ? Math.round((days / totalDays) * 1000) / 10 : 0;

  const topShare = top.reduce((sum, row) => sum + share(row.days), 0);

  const value: DashboardCharts = {
    membership_trend: trend,
    revenue: { grain, buckets, ...totals },
    top_members: top.map((row) => ({
      company_name: row.company_name,
      days: row.days,
      share_pct: share(row.days),
    })),
    // Rounded from the total rather than summed from the slices, so the donut
    // reads 100% instead of 99.9% after five roundings.
    other_share_pct: Math.max(0, Math.round((100 - topShare) * 10) / 10),
    upcoming_events: events.map((event) => ({
      id: event.id.toString(),
      title: event.title,
      start_at: event.start_at.toISOString(),
      city: event.city,
      capacity: event.capacity,
      booked: event.booked,
    })),
  };

  chartCache.set(key, { at: Date.now(), value });

  return value;
};
