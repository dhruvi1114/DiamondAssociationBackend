import { Prisma } from '@prisma/client';
import type { Db } from '@db/prisma';

/**
 * The work-queue counts behind the admin landing page (A-02, AJ-1).
 *
 * One query per tile, each narrow enough to land on an index. They are NOT
 * combined into a single statement with six sub-selects: a tile a role cannot
 * see is not asked for at all, so an ACCOUNTS admin's dashboard runs two queries
 * rather than six — and a slow tile can be found by name rather than by reading
 * one query that does everything.
 *
 * Every count answers "how many are waiting for someone", never "how many exist".
 */

/**
 * Applications a reviewer can still act on.
 *
 * SUBMITTED and UNDER_REVIEW only. RETURNED_FOR_CORRECTION is deliberately out:
 * the application was sent back to the MEMBER to fix, so the next move is
 * theirs, and a work queue answers "what is waiting for me" rather than "what is
 * unfinished". `pendingDocuments` applies the same rule to the files attached to
 * one, so the two tiles never describe the same application differently.
 */
export const openApplications = async (db: Db): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n
      FROM "MembershipApplications"
     WHERE "deletedAt" IS NULL
       AND "status"::text IN ('SUBMITTED', 'UNDER_REVIEW')
  `);

  return Number(rows[0]?.n ?? 0);
};

/**
 * Uploaded documents nobody has checked yet, across both surfaces.
 *
 * Application documents and member documents are separate tables — a document
 * attached to an application in flight, and one held against a live member —
 * and both queue for the same person, so one number covers both.
 *
 * **Documents on a returned application are excluded**, and that has to match
 * the applications tile above it. RETURNED_FOR_CORRECTION means the application
 * went back to the MEMBER to fix, so it is not in a staff queue — and neither
 * are its files. Counting the application out but its three documents in was
 * the first version of this, and it left two cards on the same screen
 * describing the same application two different ways.
 */
export const pendingDocuments = async (db: Db): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT (
      (SELECT count(*)
         FROM "ApplicationDocuments" d
         JOIN "MembershipApplications" a ON a."id" = d."application_id"
        WHERE d."deletedAt" IS NULL
          AND d."verification_status" = 'PENDING'
          AND a."deletedAt" IS NULL
          AND a."status"::text IN ('SUBMITTED', 'UNDER_REVIEW'))
      +
      (SELECT count(*) FROM "MemberDocuments"
        WHERE "deletedAt" IS NULL AND "verification_status" = 'PENDING')
    ) AS n
  `);

  return Number(rows[0]?.n ?? 0);
};

/** Profile edits a member has asked for and nobody has decided. */
export const pendingChangeRequests = async (db: Db): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n
      FROM "MemberProfileChangeRequests"
     -- This table has no soft-delete column: a change request is decided, never
     -- withdrawn out of sight, so there is nothing to exclude.
     WHERE "status" = 'PENDING'
  `);

  return Number(rows[0]?.n ?? 0);
};

/**
 * Issued invoices past their due date and still owed on.
 *
 * `balance_due > 0` rather than `status <> 'PAID'`: a part-paid invoice is still
 * money outstanding, and a status test alone would drop it out of the queue the
 * moment the first instalment landed.
 */
export const overdueInvoices = async (db: Db): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n
      FROM "Invoices"
     WHERE "status"::text IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
       AND "balance_due" > 0
       AND "due_date" < CURRENT_DATE
  `);

  return Number(rows[0]?.n ?? 0);
};

/**
 * Memberships expiring within the next 30 days, plus any already lapsed.
 *
 * The already-lapsed ones are counted deliberately. A queue that shows only what
 * is about to happen lets the thing that already happened fall off the screen,
 * and a lapsed membership is the more urgent of the two.
 */
export const renewalsDue = async (db: Db): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n
      FROM "MembershipTerms"
     WHERE "status"::text IN ('ACTIVE', 'EXPIRED')
       AND "valid_till" <= CURRENT_DATE + INTERVAL '30 days'
  `);

  return Number(rows[0]?.n ?? 0);
};

/** Messages the outbox gave up on. */
export const failedNotifications = async (db: Db): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n FROM "Notifications" WHERE "status" = 'FAILED'
  `);

  return Number(rows[0]?.n ?? 0);
};

// ---------------------------------------------------------------------------
// KPI tiles — a figure for a window, and the same figure for the window before
// ---------------------------------------------------------------------------

/**
 * Each of these takes BOTH windows and returns both figures in one query.
 *
 * Two round trips per tile would be the obvious shape and the wrong one: ten
 * queries for five tiles, each pair able to straddle a write and disagree with
 * itself. One statement per tile answers both windows from the same snapshot of
 * the table.
 */
export interface Window {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
}

export interface Pair {
  current: number;
  previous: number;
}

const pair = (rows: { current: unknown; previous: unknown }[]): Pair => ({
  current: Number(rows[0]?.current ?? 0),
  previous: Number(rows[0]?.previous ?? 0),
});

/**
 * Members active at the END of each window.
 *
 * A point in time, not a count of activity: "active members" is a headcount, and
 * the comparison worth drawing is against the headcount at the end of the
 * previous window, not against how many joined during it.
 */
export const activeMembers = async (db: Db, w: Window): Promise<Pair> => {
  const rows = await db.$queryRaw<{ current: bigint; previous: bigint }[]>(Prisma.sql`
    SELECT
      (SELECT count(*) FROM "Members"
        WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE'
          AND "createdAt" <= ${w.to}::timestamptz)               AS current,
      (SELECT count(*) FROM "Members"
        WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE'
          AND "createdAt" <= ${w.prevTo}::timestamptz)           AS previous
  `);

  return pair(rows);
};

/**
 * Money still owed on invoices past their due date, as at the end of each
 * window.
 *
 * `balance_due > 0` rather than a status test: a part-paid invoice is still
 * money outstanding, and a status test drops it the moment the first instalment
 * lands.
 */
export const overdueAmount = async (db: Db, w: Window): Promise<Pair> => {
  const rows = await db.$queryRaw<{ current: string; previous: string }[]>(Prisma.sql`
    SELECT
      COALESCE((SELECT sum("balance_due") FROM "Invoices"
                 WHERE "status"::text NOT IN ('DRAFT', 'CANCELLED')
                   AND "balance_due" > 0
                   AND "due_date" < ${w.to}::date), 0)      AS current,
      COALESCE((SELECT sum("balance_due") FROM "Invoices"
                 WHERE "status"::text NOT IN ('DRAFT', 'CANCELLED')
                   AND "balance_due" > 0
                   AND "due_date" < ${w.prevTo}::date), 0)  AS previous
  `);

  return pair(rows);
};

/** How many invoices that overdue money sits on, for the tile's sub-line. */
export const overdueInvoiceCount = async (db: Db, w: Window): Promise<number> => {
  const rows = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT count(*) AS n FROM "Invoices"
     WHERE "status"::text NOT IN ('DRAFT', 'CANCELLED')
       AND "balance_due" > 0
       AND "due_date" < ${w.to}::date
  `);

  return Number(rows[0]?.n ?? 0);
};

/**
 * Money received IN each window, from the payments themselves.
 *
 * Not `sum(amount_paid)` off the invoices: that column is a running total with
 * no date on it, so it cannot answer "collected in September". A payment row
 * has the date the money landed, which is the question.
 */
export const collected = async (db: Db, w: Window): Promise<Pair> => {
  const rows = await db.$queryRaw<{ current: string; previous: string }[]>(Prisma.sql`
    -- Status 2 is SUCCESS. REFUNDED (5) is excluded on purpose: the money came
    -- in and went out again, and a "collected" figure that counts it overstates
    -- what the association actually kept. Partially refunded (6) is excluded for
    -- the same reason and is the rougher edge of that call — netting refunds
    -- properly means joining Refunds, which this tile does not do yet.
    SELECT
      COALESCE((SELECT sum("amount") FROM "Payments"
                 WHERE "status" = 2
                   AND "paid_at" BETWEEN ${w.from}::timestamptz AND ${w.to}::timestamptz), 0)
        AS current,
      COALESCE((SELECT sum("amount") FROM "Payments"
                 WHERE "status" = 2
                   AND "paid_at" BETWEEN ${w.prevFrom}::timestamptz AND ${w.prevTo}::timestamptz), 0)
        AS previous
  `);

  return pair(rows);
};

/**
 * Applications open right now, and how many have been waiting a long time.
 *
 * A point-in-time count, so it carries no delta — comparing today's open queue
 * against last month's tells nobody anything they can act on.
 *
 * Distinct from `openApplications` above, which the work-queue card uses: that
 * one answers "how many are waiting for me" and this one adds how many have been
 * waiting too long, which is the tile's second line.
 */
export const applicationBacklog = async (db: Db): Promise<{ open: number; stale: number }> => {
  const rows = await db.$queryRaw<{ open: bigint; stale: bigint }[]>(Prisma.sql`
    SELECT count(*) AS open,
           -- "A long time" is 14 days. Long enough that a normal review has had
           -- its chance, short enough that a queue does not quietly grow a tail.
           count(*) FILTER (WHERE "createdAt" < now() - INTERVAL '14 days') AS stale
      FROM "MembershipApplications"
     WHERE "deletedAt" IS NULL
       AND "status"::text IN ('SUBMITTED', 'UNDER_REVIEW')
  `);

  return { open: Number(rows[0]?.open ?? 0), stale: Number(rows[0]?.stale ?? 0) };
};

export interface NextEventRow {
  id: bigint;
  title: string;
  start_at: Date;
  city: string | null;
  capacity: number | null;
  booked: number;
}

/**
 * The next event that has not happened yet.
 *
 * Published only: a draft event on the dashboard is a commitment nobody has made
 * yet, and staff would start telling members about it.
 */
export const nextEvent = async (db: Db): Promise<NextEventRow | null> => {
  const rows = await db.$queryRaw<NextEventRow[]>(Prisma.sql`
    SELECT e."id", e."title", e."start_at", e."city",
           e."capacity",
           COALESCE((SELECT sum(r."attendee_count")::int
                       FROM "EventRegistrations" r
                      WHERE r."event_id" = e."id" AND r."status" = 3), 0) AS booked
      FROM "Events" e
     WHERE e."start_at" >= now()
       AND e."status" = 1
     ORDER BY e."start_at" ASC
     LIMIT 1
  `);

  return rows[0] ?? null;
};

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export interface TrendPoint {
  month: string;
  active: number;
  joined: number;
  lapsed: number;
}

/**
 * Twelve months of membership: the headcount at each month end, and the moves
 * that produced it.
 *
 * `active` is a running total and the other two are flows, which is why they are
 * drawn as one line and two — a reader comparing "joined" against "active" on
 * the same axis is comparing a rate with a level.
 *
 * The month series is generated rather than derived from the data, so a month
 * in which nothing happened is a point at its true value instead of a gap the
 * chart interpolates across.
 */
export const membershipTrend = async (db: Db, months = 12): Promise<TrendPoint[]> => {
  const rows = await db.$queryRaw<
    { month: string; active: bigint; joined: bigint; lapsed: bigint }[]
  >(Prisma.sql`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', CURRENT_DATE) - (${months - 1} || ' months')::interval,
        date_trunc('month', CURRENT_DATE),
        '1 month'
      ) AS m
    )
    SELECT to_char(months.m, 'YYYY-MM') AS month,
           (SELECT count(*) FROM "Members" mm
             WHERE mm."deletedAt" IS NULL
               AND mm."status" = 'ACTIVE'
               AND mm."createdAt" < months.m + INTERVAL '1 month')      AS active,
           (SELECT count(*) FROM "Members" mj
             WHERE mj."deletedAt" IS NULL
               AND mj."createdAt" >= months.m
               AND mj."createdAt" < months.m + INTERVAL '1 month')      AS joined,
           (SELECT count(*) FROM "MembershipTerms" t
             WHERE t."status"::text = 'EXPIRED'
               AND t."valid_till" >= months.m::date
               AND t."valid_till" < (months.m + INTERVAL '1 month')::date) AS lapsed
      FROM months
     ORDER BY months.m ASC
  `);

  return rows.map((row) => ({
    month: row.month,
    active: Number(row.active),
    joined: Number(row.joined),
    lapsed: Number(row.lapsed),
  }));
};

export interface RevenueBucket {
  label: string;
  billed: string;
  collected: string;
}

/**
 * Billed against collected, bucketed across the chosen period.
 *
 * Two series because they are two different events: an invoice is raised on one
 * day and paid on another, and the gap between the bars IS the receivable. One
 * combined bar would hide the thing the chart exists to show.
 *
 * Billed comes off the invoice's issue date, collected off the payment's own
 * date — never off `amount_paid`, which is a running total with no date on it
 * and cannot answer "collected in this week".
 */
export const revenueBuckets = async (
  db: Db,
  w: Window,
  grain: 'day' | 'week' | 'month',
): Promise<RevenueBucket[]> => {
  const unit = Prisma.raw(`'${grain}'`);

  const rows = await db.$queryRaw<{ label: Date; billed: string; collected: string }[]>(Prisma.sql`
    WITH buckets AS (
      SELECT generate_series(
        date_trunc(${unit}, ${w.from}::timestamptz),
        date_trunc(${unit}, ${w.to}::timestamptz),
        ('1 ' || ${unit})::interval
      ) AS b
    )
    SELECT buckets.b AS label,
           COALESCE((SELECT sum(i."total_amount") FROM "Invoices" i
                      WHERE i."status"::text NOT IN ('DRAFT', 'CANCELLED')
                        AND i."issue_date" >= buckets.b::date
                        AND i."issue_date" < (buckets.b + ('1 ' || ${unit})::interval)::date), 0)
             AS billed,
           COALESCE((SELECT sum(p."amount") FROM "Payments" p
                      WHERE p."status" = 2
                        AND p."paid_at" >= buckets.b
                        AND p."paid_at" < buckets.b + ('1 ' || ${unit})::interval), 0)
             AS collected
      FROM buckets
     ORDER BY buckets.b ASC
  `);

  return rows.map((row) => ({
    label: row.label.toISOString(),
    billed: String(row.billed),
    collected: String(row.collected),
  }));
};

export interface RevenueTotals {
  billed: string;
  collected: string;
  pending: string;
  refunded: string;
}

/** The four figures above the revenue chart, for the same window. */
export const revenueTotals = async (db: Db, w: Window): Promise<RevenueTotals> => {
  const rows = await db.$queryRaw<RevenueTotals[]>(Prisma.sql`
    SELECT
      COALESCE((SELECT sum("total_amount") FROM "Invoices"
                 WHERE "status"::text NOT IN ('DRAFT', 'CANCELLED')
                   AND "issue_date" BETWEEN ${w.from}::date AND ${w.to}::date), 0) AS billed,
      COALESCE((SELECT sum("amount") FROM "Payments"
                 WHERE "status" = 2
                   AND "paid_at" BETWEEN ${w.from}::timestamptz AND ${w.to}::timestamptz), 0)
        AS collected,
      -- Still owed on invoices RAISED in this window, which is the figure that
      -- pairs with the billed bar above it. Not all outstanding money ever.
      COALESCE((SELECT sum("balance_due") FROM "Invoices"
                 WHERE "status"::text NOT IN ('DRAFT', 'CANCELLED')
                   AND "issue_date" BETWEEN ${w.from}::date AND ${w.to}::date), 0) AS pending,
      -- Status 2 is COMPLETED: money that actually went back. A requested or
      -- processing refund has not left the account and is not a cost yet.
      COALESCE((SELECT sum("amount") FROM "Refunds"
                 WHERE "status" = 2
                   AND "createdAt" BETWEEN ${w.from}::timestamptz AND ${w.to}::timestamptz), 0)
        AS refunded
  `);

  return rows[0] ?? { billed: '0', collected: '0', pending: '0', refunded: '0' };
};

export interface TenureSlice {
  member_id: string | null;
  company_name: string;
  days: number;
}

/**
 * The longest-standing members, by how long they have been covered.
 *
 * Tenure is summed across TERMS rather than measured from the join date: a
 * membership that lapsed for a year and was renewed has not been a member for
 * that year, and counting it would put a returning member above one who never
 * left.
 */
export const topMembersByTenure = async (db: Db, limit = 5): Promise<TenureSlice[]> => {
  const rows = await db.$queryRaw<{ member_id: bigint; company_name: string; days: number }[]>(
    Prisma.sql`
    SELECT m."id" AS member_id,
           m."company_name",
           SUM(LEAST(t."valid_till", CURRENT_DATE) - t."valid_from")::int AS days
      FROM "MembershipTerms" t
      JOIN "Members" m ON m."id" = t."member_id"
     WHERE m."deletedAt" IS NULL
       AND t."status"::text IN ('ACTIVE', 'EXPIRED')
       AND t."valid_from" <= CURRENT_DATE
     GROUP BY m."id", m."company_name"
     HAVING SUM(LEAST(t."valid_till", CURRENT_DATE) - t."valid_from") > 0
     ORDER BY days DESC
     LIMIT ${limit}
  `,
  );

  return rows.map((row) => ({
    member_id: row.member_id.toString(),
    company_name: row.company_name,
    days: Number(row.days),
  }));
};

/** Total tenure across every member, so the donut can show an "Others" slice. */
export const totalTenureDays = async (db: Db): Promise<number> => {
  const rows = await db.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(LEAST(t."valid_till", CURRENT_DATE) - t."valid_from"), 0)::int AS n
      FROM "MembershipTerms" t
      JOIN "Members" m ON m."id" = t."member_id"
     WHERE m."deletedAt" IS NULL
       AND t."status"::text IN ('ACTIVE', 'EXPIRED')
       AND t."valid_from" <= CURRENT_DATE
  `);

  return Number(rows[0]?.n ?? 0);
};

export interface UpcomingEventRow {
  id: bigint;
  title: string;
  start_at: Date;
  city: string | null;
  capacity: number | null;
  booked: number;
}

/** The next few published events, for the panel under the charts. */
export const upcomingEvents = async (db: Db, limit = 3): Promise<UpcomingEventRow[]> =>
  db.$queryRaw<UpcomingEventRow[]>(Prisma.sql`
    SELECT e."id", e."title", e."start_at", e."city", e."capacity",
           COALESCE((SELECT sum(r."attendee_count")::int
                       FROM "EventRegistrations" r
                      WHERE r."event_id" = e."id" AND r."status" = 3), 0) AS booked
      FROM "Events" e
     WHERE e."start_at" >= now() AND e."status" = 1
     ORDER BY e."start_at" ASC
     LIMIT ${limit}
  `);
