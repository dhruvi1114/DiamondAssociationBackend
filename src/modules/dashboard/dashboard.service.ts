import { prisma } from '@db/prisma';
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
  documents: { permission: 'document.verify', count: repo.pendingDocuments },
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
