import { Prisma } from '@prisma/client';
import type { Db } from '@db/prisma';
import type { ReportRow } from '@modules/report/report.types';

/**
 * The four report queries (screen A-29).
 *
 * Every one of them is a read. Nothing in this module writes, and no report
 * derives a number the frontend could have added up itself — the definition of
 * done for M10 is that no figure on a report or a dashboard is computed in the
 * browser, and the reason is that two places computing "revenue collected"
 * eventually disagree about whether a refund counts.
 *
 * Pagination is applied to the screen's query and deliberately NOT to the
 * export's: the export is the whole result set, and its row count must equal the
 * count the screen reports. Both come from the same `COUNT(*) OVER ()`.
 */

export interface ReportParams {
  /** Omitted for an export, which takes every row. */
  page?: number;
  limit?: number;
  search?: string;
  statuses?: string[];
  categoryIds?: string[];
  cities?: string[];
  states?: string[];
  from?: string;
  to?: string;
  invoiceTypes?: string[];
  /** Specific companies. Empty or absent means every company. */
  memberIds?: string[];
  /** Specific events. */
  eventIds?: string[];
}

export interface ReportQueryResult {
  rows: ReportRow[];
  total: number;
}

/** `LIMIT ... OFFSET ...`, or nothing at all when the caller wants every row. */
const window = (params: ReportParams): Prisma.Sql =>
  params.page !== undefined && params.limit !== undefined
    ? Prisma.sql`LIMIT ${params.limit} OFFSET ${(params.page - 1) * params.limit}`
    : Prisma.empty;

const shape = (rows: (ReportRow & { total?: bigint })[]): ReportQueryResult => ({
  rows: rows.map(({ total: _total, ...row }) => row),
  total: rows[0]?.total !== undefined ? Number(rows[0].total) : rows.length,
});

/**
 * Members, one row per company.
 *
 * Categories are aggregated rather than joined into duplicate rows: a member in
 * two categories is one member, and a report that counts them twice is a report
 * the association cannot quote. City and state come off the SAME address row via
 * LATERAL — as two independent subqueries a member with a registered and a
 * factory address could show one's city beside the other's state.
 */
export const members = async (db: Db, params: ReportParams): Promise<ReportQueryResult> => {
  const search = params.search ? `%${params.search}%` : null;
  const statuses = params.statuses?.length ? params.statuses : null;
  const categoryIds = params.categoryIds?.length ? params.categoryIds : null;
  const cities = params.cities?.length ? params.cities : null;
  const states = params.states?.length ? params.states : null;
  const memberIds = params.memberIds?.length ? params.memberIds : null;

  const rows = await db.$queryRaw<(ReportRow & { total: bigint })[]>(Prisma.sql`
    SELECT m."member_code"   AS member_code,
           m."company_name"  AS company_name,
           COALESCE(string_agg(DISTINCT cat."name", ', '), '') AS category,
           addr.city         AS city,
           addr.state        AS state,
           m."status"::text  AS status,
           m."createdAt"     AS joined_on,
           COUNT(*) OVER ()  AS total
      FROM "Members" m
      LEFT JOIN "MemberCategories"     mcat ON mcat."member_id"   = m."id"
      LEFT JOIN "MembershipCategories" cat  ON cat."id"           = mcat."category_id"
      LEFT JOIN LATERAL (
        SELECT a."city", a."state"
          FROM "MemberAddresses" a
         WHERE a."member_id" = m."id" AND a."deletedAt" IS NULL
         ORDER BY a."is_primary" DESC, a."id" ASC
         LIMIT 1
      ) addr ON TRUE
     WHERE m."deletedAt" IS NULL
       AND (${statuses}::text[] IS NULL OR m."status"::text = ANY(${statuses}::text[]))
       AND (${cities}::text[] IS NULL OR addr.city = ANY(${cities}::text[]))
       AND (${states}::text[] IS NULL OR addr.state = ANY(${states}::text[]))
       AND (${categoryIds}::bigint[] IS NULL
            OR EXISTS (SELECT 1 FROM "MemberCategories" mc2
                        WHERE mc2."member_id" = m."id"
                          AND mc2."category_id" = ANY(${categoryIds}::bigint[])))
       AND (${memberIds}::bigint[] IS NULL OR m."id" = ANY(${memberIds}::bigint[]))
       AND (${search}::text IS NULL
            OR m."company_name" ILIKE ${search}
            OR m."member_code" ILIKE ${search})
     GROUP BY m."id", addr.city, addr.state
     ORDER BY m."company_name" ASC
     ${window(params)}
  `);

  return shape(rows);
};

/**
 * Revenue by month.
 *
 * DRAFT and CANCELLED invoices are excluded, and that is a judgement worth
 * stating: a draft has not been issued to anybody, so it is not money owed, and
 * a cancelled invoice was withdrawn rather than unpaid. Counting either would
 * make "outstanding" a number nobody can chase.
 *
 * The three money columns come off the invoice itself rather than off the
 * payments table. `amount_paid` and `balance_due` are maintained by the payment
 * service inside the transaction that records a payment, so they already account
 * for part payments and refunds; summing `Payments` separately would drift from
 * them the first time a refund landed.
 */
export const revenue = async (db: Db, params: ReportParams): Promise<ReportQueryResult> => {
  const from = params.from ?? null;
  const to = params.to ?? null;
  const types = params.invoiceTypes?.length ? params.invoiceTypes : null;
  const memberIds = params.memberIds?.length ? params.memberIds : null;

  const rows = await db.$queryRaw<(ReportRow & { total: bigint })[]>(Prisma.sql`
    SELECT to_char(i."issue_date", 'YYYY-MM')  AS period,
           COUNT(*)::int                        AS invoices,
           SUM(i."total_amount")                AS billed,
           SUM(i."amount_paid")                 AS collected,
           SUM(i."balance_due")                 AS outstanding,
           COUNT(*) OVER ()                     AS total
      FROM "Invoices" i
     WHERE i."status"::text NOT IN ('DRAFT', 'CANCELLED')
       AND (${from}::date IS NULL OR i."issue_date" >= ${from}::date)
       AND (${to}::date IS NULL OR i."issue_date" <= ${to}::date)
       AND (${types}::text[] IS NULL OR i."invoice_type"::text = ANY(${types}::text[]))
       -- One member's billing history, month by month. A guest invoice carries no
       -- member_id, so naming a member correctly excludes guest bookings.
       AND (${memberIds}::bigint[] IS NULL OR i."member_id" = ANY(${memberIds}::bigint[]))
     GROUP BY 1
     ORDER BY 1 DESC
     ${window(params)}
  `);

  return shape(rows);
};

/**
 * Terms by expiry date — "who is about to lapse".
 *
 * Ordered by expiry ascending, not by company: the report exists to be worked
 * top-down, and the row that matters most is the one expiring soonest.
 * `days_remaining` is negative for a term that has already run out, which is
 * what makes the overdue rows sort to the top and read as overdue.
 */
export const renewals = async (db: Db, params: ReportParams): Promise<ReportQueryResult> => {
  const from = params.from ?? null;
  const to = params.to ?? null;
  const statuses = params.statuses?.length ? params.statuses : null;
  const memberIds = params.memberIds?.length ? params.memberIds : null;

  const rows = await db.$queryRaw<(ReportRow & { total: bigint })[]>(Prisma.sql`
    SELECT m."member_code"                            AS member_code,
           m."company_name"                           AS company_name,
           cat."name"                                 AS category,
           t."valid_from"                             AS valid_from,
           t."valid_till"                             AS valid_till,
           (t."valid_till" - CURRENT_DATE)::int       AS days_remaining,
           t."status"::text                           AS status,
           COUNT(*) OVER ()                           AS total
      FROM "MembershipTerms" t
      JOIN "Members"              m   ON m."id"   = t."member_id"
      JOIN "MembershipCategories" cat ON cat."id" = t."category_id"
     WHERE m."deletedAt" IS NULL
       AND (${from}::date IS NULL OR t."valid_till" >= ${from}::date)
       AND (${to}::date IS NULL OR t."valid_till" <= ${to}::date)
       AND (${statuses}::text[] IS NULL OR t."status"::text = ANY(${statuses}::text[]))
       AND (${memberIds}::bigint[] IS NULL OR m."id" = ANY(${memberIds}::bigint[]))
     ORDER BY t."valid_till" ASC
     ${window(params)}
  `);

  return shape(rows);
};

/**
 * Events, one row each: how many booked, how many people that was, what it took.
 *
 * Not a copy of the attendee list — that already exists per event, with its own
 * export. This answers the question the attendee list cannot: how the events
 * compare.
 *
 * Registrations and attendees are counted in separate LATERAL subqueries rather
 * than by joining both tables: a single join across bookings AND their attendees
 * multiplies the two counts together, which is the classic way an attendance
 * report ends up reporting four times the people who came.
 */
export const events = async (db: Db, params: ReportParams): Promise<ReportQueryResult> => {
  const from = params.from ?? null;
  const to = params.to ?? null;
  const search = params.search ? `%${params.search}%` : null;
  const eventIds = params.eventIds?.length ? params.eventIds : null;

  const rows = await db.$queryRaw<(ReportRow & { total: bigint })[]>(Prisma.sql`
    SELECT e."title"                       AS event,
           e."start_at"                    AS event_date,
           booked.registrations            AS registrations,
           booked.attendees                AS attendees,
           booked.revenue                  AS revenue,
           COUNT(*) OVER ()                AS total
      FROM "Events" e
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS registrations,
               -- Confirmed bookings only (status 3). A cancelled or expired
               -- booking is not money and was not a person in the room.
               COALESCE(SUM(r."total_amount") FILTER (WHERE r."status" = 3), 0) AS revenue,
               COALESCE(
                 (SELECT COUNT(*)::int
                    FROM "EventRegistrationAttendees" a
                    JOIN "EventRegistrations" r2 ON r2."id" = a."registration_id"
                   WHERE r2."event_id" = e."id" AND r2."status" = 3),
                 0
               ) AS attendees
          FROM "EventRegistrations" r
         WHERE r."event_id" = e."id"
      ) booked ON TRUE
     WHERE (${from}::date IS NULL OR e."start_at"::date >= ${from}::date)
       AND (${to}::date IS NULL OR e."start_at"::date <= ${to}::date)
       AND (${eventIds}::bigint[] IS NULL OR e."id" = ANY(${eventIds}::bigint[]))
       AND (${search}::text IS NULL OR e."title" ILIKE ${search})
     ORDER BY e."start_at" DESC
     ${window(params)}
  `);

  return shape(rows);
};

/**
 * One member's statement: every invoice raised against them.
 *
 * The document an office sends when a company queries its dues. Unlike the
 * revenue report — which groups by month across everybody — this is one
 * company's whole billing history, oldest first, because a statement is read
 * downwards as a story rather than scanned for the most recent line.
 *
 * DRAFT and CANCELLED are excluded for the same reason the revenue report
 * excludes them: a draft was never issued to this company, and a cancelled
 * invoice was withdrawn rather than left unpaid. Showing either on a statement
 * invites a payment against a bill that does not exist.
 */
export const memberStatement = async (db: Db, params: ReportParams): Promise<ReportQueryResult> => {
  const memberIds = params.memberIds?.length ? params.memberIds : null;
  const from = params.from ?? null;
  const to = params.to ?? null;

  const rows = await db.$queryRaw<(ReportRow & { total: bigint })[]>(Prisma.sql`
    SELECT i."invoice_number"      AS invoice_number,
           i."invoice_type"::text  AS invoice_type,
           i."issue_date"          AS issue_date,
           i."due_date"            AS due_date,
           i."total_amount"        AS billed,
           i."amount_paid"         AS collected,
           i."balance_due"         AS outstanding,
           i."status"::text        AS status,
           COUNT(*) OVER ()        AS total
      FROM "Invoices" i
     WHERE i."status"::text NOT IN ('DRAFT', 'CANCELLED')
       AND (${memberIds}::bigint[] IS NULL OR i."member_id" = ANY(${memberIds}::bigint[]))
       AND (${from}::date IS NULL OR i."issue_date" >= ${from}::date)
       AND (${to}::date IS NULL OR i."issue_date" <= ${to}::date)
     ORDER BY i."issue_date" ASC, i."invoice_number" ASC
  `);

  return shape(rows);
};

// ---------------------------------------------------------------------------
// Detail grains
// ---------------------------------------------------------------------------

/*
  Two reports summarise at a coarser grain than the thing anyone wants listed.

  "Event Attendance" is one row per event, so its own rows are not a detail of
  anything — asking for the breakdown of a single event and getting that same
  single row back is not a breakdown. The rows underneath an event are its
  ATTENDEES. Revenue has the same shape: a row is a month, and the rows
  underneath a month are its INVOICES.

  Members and Renewals need none of this: their summary rows already ARE the
  finest grain they have.
*/

/** Every attendee across the events the report matched. */
export const eventAttendees = async (db: Db, params: ReportParams): Promise<ReportQueryResult> => {
  const from = params.from ?? null;
  const to = params.to ?? null;
  const search = params.search ? `%${params.search}%` : null;
  const eventIds = params.eventIds?.length ? params.eventIds : null;

  const rows = await db.$queryRaw<(ReportRow & { total: bigint })[]>(Prisma.sql`
    SELECT e."title"              AS event,
           e."start_at"           AS event_date,
           a."full_name"          AS attendee,
           a."designation"        AS designation,
           a."email"::text        AS email,
           a."phone"              AS phone,
           r."registration_code"  AS booking,
           a."unit_price"         AS amount,
           COUNT(*) OVER ()       AS total
      FROM "EventRegistrationAttendees" a
      JOIN "EventRegistrations" r ON r."id"       = a."registration_id"
      JOIN "Events"             e ON e."id"       = r."event_id"
     -- Confirmed bookings only (status 3), matching the summary above it. A
     -- cancelled booking is not a person who was in the room, and a detail sheet
     -- that counts differently from its own summary is worse than none.
     WHERE r."status" = 3
       AND (${eventIds}::bigint[] IS NULL OR e."id" = ANY(${eventIds}::bigint[]))
       AND (${from}::date IS NULL OR e."start_at"::date >= ${from}::date)
       AND (${to}::date IS NULL OR e."start_at"::date <= ${to}::date)
       AND (${search}::text IS NULL OR e."title" ILIKE ${search}::text)
     ORDER BY e."start_at" DESC, a."full_name" ASC
  `);

  return shape(rows);
};

/** Every invoice behind the months the revenue report matched. */
export const revenueInvoices = async (db: Db, params: ReportParams): Promise<ReportQueryResult> => {
  const from = params.from ?? null;
  const to = params.to ?? null;
  const types = params.invoiceTypes?.length ? params.invoiceTypes : null;
  const memberIds = params.memberIds?.length ? params.memberIds : null;

  const rows = await db.$queryRaw<(ReportRow & { total: bigint })[]>(Prisma.sql`
    SELECT i."invoice_number"      AS invoice_number,
           m."company_name"        AS company_name,
           i."invoice_type"::text  AS invoice_type,
           i."issue_date"          AS issue_date,
           i."due_date"            AS due_date,
           i."total_amount"        AS billed,
           i."amount_paid"         AS collected,
           i."balance_due"         AS outstanding,
           i."status"::text        AS status,
           COUNT(*) OVER ()        AS total
      FROM "Invoices" i
      LEFT JOIN "Members" m ON m."id" = i."member_id"
     -- The same exclusion the monthly totals make, for the same reason: a draft
     -- is not money owed and a cancelled invoice was withdrawn.
     WHERE i."status"::text NOT IN ('DRAFT', 'CANCELLED')
       AND (${from}::date IS NULL OR i."issue_date" >= ${from}::date)
       AND (${to}::date IS NULL OR i."issue_date" <= ${to}::date)
       AND (${types}::text[] IS NULL OR i."invoice_type"::text = ANY(${types}::text[]))
       AND (${memberIds}::bigint[] IS NULL OR i."member_id" = ANY(${memberIds}::bigint[]))
     ORDER BY i."issue_date" DESC, i."invoice_number" DESC
  `);

  return shape(rows);
};

// ---------------------------------------------------------------------------
// Generated reports — the saved records themselves
// ---------------------------------------------------------------------------

/** One row of `GeneratedReports`, as Postgres returns it. */
export interface GeneratedReportRow {
  id: bigint;
  report_type: string;
  report_name: string;
  from_date: Date | null;
  to_date: Date | null;
  filters: unknown;
  include_details: boolean;
  report_data: unknown;
  status: string;
  row_count: bigint;
  error_message: string | null;
  generated_by: bigint;
  createdAt: Date;
}

export const insertGeneratedReport = async (
  db: Db,
  input: {
    reportType: string;
    reportName: string;
    fromDate: string | null;
    toDate: string | null;
    filters: unknown;
    includeDetails: boolean;
    reportData: unknown;
    rowCount: number;
    generatedBy: bigint;
  },
): Promise<GeneratedReportRow> =>
  db.generatedReport.create({
    data: {
      report_type: input.reportType,
      report_name: input.reportName,
      from_date: input.fromDate ? new Date(input.fromDate) : null,
      to_date: input.toDate ? new Date(input.toDate) : null,
      filters: input.filters as never,
      include_details: input.includeDetails,
      report_data: input.reportData as never,
      status: 'ready',
      row_count: BigInt(input.rowCount),
      generated_by: input.generatedBy,
    },
  }) as unknown as Promise<GeneratedReportRow>;

/**
 * The list, newest first.
 *
 * The generator's name is joined in. Unlike the audit log's actor this IS a
 * foreign key with ON DELETE RESTRICT, so a report can never point at a staff
 * row that is gone and the join can never silently drop one.
 *
 * `report_data` is deliberately NOT selected: it holds every detail row of
 * every report on the page, and the list shows none of them.
 */
export const listGeneratedReports = async (
  db: Db,
  params: {
    page: number;
    limit: number;
    search?: string;
    reportType?: string;
    generatedBy?: string;
  },
): Promise<{ rows: (GeneratedReportRow & { generated_by_name: string })[]; total: number }> => {
  const offset = (params.page - 1) * params.limit;
  const search = params.search ? `%${params.search}%` : null;
  const reportType = params.reportType ?? null;
  const generatedBy = params.generatedBy ?? null;

  const rows = await db.$queryRaw<
    (GeneratedReportRow & { generated_by_name: string; total: bigint })[]
  >(Prisma.sql`
    SELECT g."id", g."report_type", g."report_name", g."from_date", g."to_date",
           g."filters", g."include_details", g."status", g."row_count",
           g."error_message", g."generated_by", g."createdAt",
           au."full_name"   AS generated_by_name,
           COUNT(*) OVER () AS total
      FROM "GeneratedReports" g
      JOIN "AdminUsers" au ON au."id" = g."generated_by"
     WHERE (${search}::text IS NULL OR g."report_name" ILIKE ${search}::text)
       AND (${reportType}::text IS NULL OR g."report_type" = ${reportType}::text)
       AND (${generatedBy}::bigint IS NULL OR g."generated_by" = ${generatedBy}::bigint)
     ORDER BY g."createdAt" DESC, g."id" DESC
     LIMIT ${params.limit} OFFSET ${offset}
  `);

  return {
    rows: rows.map(({ total: _total, ...row }) => ({ ...row, report_data: {} })),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
};

/** One report, with its stored result. */
export const findGeneratedReport = async (
  db: Db,
  id: bigint,
): Promise<(GeneratedReportRow & { generated_by_name: string }) | null> => {
  const rows = await db.$queryRaw<(GeneratedReportRow & { generated_by_name: string })[]>(
    Prisma.sql`
    SELECT g.*, au."full_name" AS generated_by_name
      FROM "GeneratedReports" g
      JOIN "AdminUsers" au ON au."id" = g."generated_by"
     WHERE g."id" = ${id}
  `,
  );

  return rows[0] ?? null;
};
