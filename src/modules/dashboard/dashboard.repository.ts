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
