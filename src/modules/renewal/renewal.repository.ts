import { Prisma } from '@prisma/client';
import type { Db } from '@db/prisma';
import { SUBMISSION_STATUS } from '@modules/event/registration.constants';
import { isoDay } from '@modules/renewal/renewal.dates';

export interface DueCandidate {
  term_id: bigint;
  member_id: bigint;
  category_id: bigint;
  tier_id: bigint | null;
  fee_plan_id: bigint | null;
  valid_till: Date;
  member_code: string | null;
  company_name: string;
}

/**
 * Members whose current term ends within the notice window (or has ended — a member in grace
 * whose invoice was never raised is still owed one) and who have no live next term yet.
 *
 * Date parameters are bound as ISO text (`isoDay(...)`), not the raw `Date`. `Prisma.sql` binds a
 * plain JS `Date` as `timestamptz`, and `timestamptz::date` then depends on the database session's
 * timezone — under a negative-offset session a UTC-midnight calendar day can cast back a day
 * early. `'2027-09-11'::date` means 11 Sep regardless of session timezone.
 */
export const dueCandidates = (db: Db, horizon: Date) =>
  db.$queryRaw<DueCandidate[]>(Prisma.sql`
    SELECT t.id AS term_id, t.member_id, t.category_id, t.tier_id, t.fee_plan_id, t.valid_till,
           m.member_code, m.company_name
    FROM "Members" m
    JOIN "MembershipTerms" t ON t.id = m.current_term_id
    WHERE m.status = 'ACTIVE' AND m."deletedAt" IS NULL
      AND t.status IN ('ACTIVE', 'EXPIRED')
      AND t.valid_till <= ${isoDay(horizon)}::date
      AND t.renewal_declined_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "MembershipTerms" n
        WHERE n.member_id = t.member_id
          AND n.valid_from = t.valid_till + 1
          AND n.status <> 'CANCELLED')
    ORDER BY t.valid_till, t.member_id
  `);

export interface ReminderCandidate {
  term_id: bigint;
  member_id: bigint;
  valid_from: Date;
  invoice_number: string;
  total_amount: Prisma.Decimal;
  currency: string;
  due_date: Date;
  plan_name: string | null;
}

/**
 * Unpaid renewal invoices whose current term ends today or within 15 days, no claim filed.
 *
 * `PaymentSubmissions.status` is a `smallint` code (0 = PENDING, 1 = VERIFIED, 2 = REJECTED —
 * `registration.constants.ts` `SUBMISSION_STATUS`), not the string the brief's literal named, so
 * the claim-filed check below compares against the numeric code.
 */
export const reminderCandidates = (db: Db, today: Date) =>
  db.$queryRaw<ReminderCandidate[]>(Prisma.sql`
    SELECT n.id AS term_id, n.member_id, n.valid_from, i.invoice_number, i.total_amount,
           i.currency, i.due_date, p.name AS plan_name
    FROM "MembershipTerms" n
    JOIN "Invoices" i ON i.id = n.invoice_id AND i."deletedAt" IS NULL
    LEFT JOIN "FeePlans" p ON p.id = n.fee_plan_id
    WHERE n.term_type = 'RENEWAL' AND n.status = 'PENDING_PAYMENT'
      AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
      AND n.valid_from - 1 BETWEEN ${isoDay(today)}::date AND ${isoDay(today)}::date + 15
      AND NOT EXISTS (
        SELECT 1 FROM "PaymentSubmissions" s
        WHERE s.invoice_id = i.id AND s.status = ${SUBMISSION_STATUS.PENDING})
  `);

/** Inserts the reminder row; returns 1 when inserted, 0 when this stage was already sent. */
export const claimReminder = (db: Db, termId: bigint, code: string, today: Date) =>
  db.$executeRaw(Prisma.sql`
    INSERT INTO "RenewalReminders" ("term_id", "reminder_code", "sent_on")
    VALUES (${termId}, ${code}, ${isoDay(today)}::date)
    ON CONFLICT ("term_id", "reminder_code") DO NOTHING
  `);

/* -------------------------------------------------------------------------- */
/* Admin buckets (A-20) — one CTE, shared by the summary counts and the list. */
/* -------------------------------------------------------------------------- */

export type Bucket = 'due' | 'grace' | 'expired';

const bucketBase = () => Prisma.sql`
  WITH cur AS (
    SELECT m.id AS member_id, m.member_code, m.company_name, m.status AS member_status,
           t.valid_till, t.fee_plan_id, t.renewal_declined_at
    FROM "Members" m
    JOIN "MembershipTerms" t ON t.id = m.current_term_id
    WHERE m."deletedAt" IS NULL
      AND t.status IN ('ACTIVE', 'EXPIRED')
      AND NOT EXISTS (
        SELECT 1 FROM "MembershipTerms" n
        WHERE n.member_id = m.id AND n.valid_from = t.valid_till + 1
          AND n.status IN ('PAID_UPCOMING', 'ACTIVE'))
  )`;

const bucketWhere = (bucket: Bucket, today: Date, horizon: Date) => {
  switch (bucket) {
    case 'due':
      return Prisma.sql`cur.member_status = 'ACTIVE' AND cur.valid_till BETWEEN ${isoDay(today)}::date AND ${isoDay(horizon)}::date`;
    case 'grace':
      return Prisma.sql`cur.member_status = 'ACTIVE' AND cur.valid_till < ${isoDay(today)}::date`;
    case 'expired':
      return Prisma.sql`cur.member_status = 'EXPIRED'`;
  }
};

export const bucketSummary = async (db: Db, today: Date, horizon: Date) => {
  const [row] = await db.$queryRaw<{ due: number; grace: number; expired: number }[]>(Prisma.sql`
    ${bucketBase()}
    SELECT
      COUNT(*) FILTER (WHERE ${bucketWhere('due', today, horizon)})::int     AS due,
      COUNT(*) FILTER (WHERE ${bucketWhere('grace', today, horizon)})::int   AS grace,
      COUNT(*) FILTER (WHERE ${bucketWhere('expired', today, horizon)})::int AS expired
    FROM cur
  `);
  return row ?? { due: 0, grace: 0, expired: 0 };
};

export interface BucketRow {
  member_id: bigint;
  member_code: string | null;
  company_name: string;
  plan_name: string | null;
  billing_cycle: string | null;
  valid_till: Date;
  renewal_term_id: bigint | null;
  renewal_status: string | null;
  invoice_id: bigint | null;
  invoice_number: string | null;
  invoice_total: Prisma.Decimal | null;
  invoice_status: string | null;
  claim_pending: boolean;
  renewal_declined: boolean;
  total: number;
}

export const bucketRows = (
  db: Db,
  p: {
    bucket: Bucket;
    today: Date;
    horizon: Date;
    search: string | null;
    limit: number;
    offset: number;
  },
) =>
  db.$queryRaw<BucketRow[]>(Prisma.sql`
    ${bucketBase()}
    SELECT cur.member_id, cur.member_code, cur.company_name,
           fp.name AS plan_name, fp.billing_cycle::text AS billing_cycle, cur.valid_till,
           n.id AS renewal_term_id, n.status::text AS renewal_status,
           i.id AS invoice_id, i.invoice_number, i.total_amount AS invoice_total,
           i.status::text AS invoice_status,
           EXISTS (SELECT 1 FROM "PaymentSubmissions" s
                   WHERE s.invoice_id = i.id AND s.status = ${SUBMISSION_STATUS.PENDING}) AS claim_pending,
           (cur.renewal_declined_at IS NOT NULL) AS renewal_declined,
           COUNT(*) OVER ()::int AS total
    FROM cur
    LEFT JOIN "FeePlans" fp ON fp.id = cur.fee_plan_id
    LEFT JOIN "MembershipTerms" n
      ON n.member_id = cur.member_id AND n.valid_from = cur.valid_till + 1 AND n.status <> 'CANCELLED'
    LEFT JOIN "Invoices" i ON i.id = n.invoice_id
    WHERE ${bucketWhere(p.bucket, p.today, p.horizon)}
      ${p.search ? Prisma.sql`AND (cur.company_name ILIKE ${`%${p.search}%`} OR cur.member_code ILIKE ${`%${p.search}%`})` : Prisma.empty}
    ORDER BY cur.valid_till ASC, cur.company_name ASC
    LIMIT ${p.limit} OFFSET ${p.offset}
  `);
