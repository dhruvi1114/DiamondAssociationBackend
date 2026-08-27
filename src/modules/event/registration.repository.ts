import { Prisma } from '@prisma/client';
import { EVENT_STATUS } from '@modules/event/event.constants';
import type { Db } from '@db/prisma';

/**
 * Seat accounting.
 *
 * The whole module exists to make one thing impossible: two people buying the
 * same last seat. That is not achievable by reading `seats_taken`, deciding, and
 * writing it back — between the read and the write another request does the
 * same, and both succeed.
 *
 * So the decision and the write are one statement, and the database is what
 * refuses. `CK seats_taken <= capacity` sits behind it as the backstop for any
 * future code path that writes the column another way.
 */

/**
 * Take `seats` for an event, or refuse.
 *
 * Returns the new total when the seats were taken, or `null` when they were not
 * — because the event is not published, no longer exists, or has fewer seats
 * left than asked for. `null` is an ordinary answer, not an error: the caller
 * rolls its transaction back and tells the booker *before* any invoice exists.
 */
export const takeSeats = async (db: Db, eventId: bigint, seats: number): Promise<number | null> => {
  const rows = await db.$queryRaw<{ seats_taken: number }[]>(Prisma.sql`
    UPDATE "Events"
       SET "seats_taken" = "seats_taken" + ${seats},
           "updatedAt" = now()
     WHERE "id" = ${eventId}
       AND "deletedAt" IS NULL
       AND "status" = ${EVENT_STATUS.PUBLISHED}
       AND ("capacity" IS NULL OR "seats_taken" + ${seats} <= "capacity")
    RETURNING "seats_taken"
  `);

  return rows[0]?.seats_taken ?? null;
};

/**
 * Give `seats` back — an expired hold, a cancellation, a refused approval.
 *
 * Guarded the same way so the counter can never go negative, which would let the
 * event oversell later by exactly the amount it went below zero. A release that
 * finds nothing to release returns null rather than throwing: the sweep job runs
 * over many rows and one already-released booking must not stop the rest.
 */
export const releaseSeats = async (
  db: Db,
  eventId: bigint,
  seats: number,
): Promise<number | null> => {
  const rows = await db.$queryRaw<{ seats_taken: number }[]>(Prisma.sql`
    UPDATE "Events"
       SET "seats_taken" = "seats_taken" - ${seats},
           "updatedAt" = now()
     WHERE "id" = ${eventId}
       AND "seats_taken" >= ${seats}
    RETURNING "seats_taken"
  `);

  return rows[0]?.seats_taken ?? null;
};

export interface AdminRegistrationRow {
  id: bigint;
  registration_code: string;
  event_id: bigint;
  event_title: string;
  registrant_type: number;
  status: number;
  attendee_count: number;
  total_amount: Prisma.Decimal;
  registered_at: Date;
  expires_at: Date | null;
  booked_by: string | null;
  invoice_number: string | null;
  total: bigint;
}

/**
 * Bookings for the admin screens, filtered by event and status.
 *
 * One statement with a windowed count and the payer's name resolved from
 * whichever side it lives on — the alternative is fetching the page and then
 * asking per row who booked it, which is the N+1 this codebase avoids (ADR-005).
 */
export const listRegistrationsAdmin = (
  db: Db,
  query: { eventId?: bigint; statuses?: number[]; page: number; limit: number },
) => {
  const offset = (query.page - 1) * query.limit;
  const statuses = query.statuses && query.statuses.length > 0 ? query.statuses : null;

  return db.$queryRaw<AdminRegistrationRow[]>(Prisma.sql`
    SELECT r."id", r."registration_code", r."event_id", e."title" AS event_title,
           r."registrant_type", r."status", r."attendee_count", r."total_amount",
           r."registered_at", r."expires_at",
           COALESCE(m."company_name", g."company_name", g."full_name") AS booked_by,
           i."invoice_number",
           count(*) OVER () AS total
      FROM "EventRegistrations" r
      JOIN "Events" e ON e."id" = r."event_id"
      LEFT JOIN "Members" m ON m."id" = r."member_id"
      LEFT JOIN "GuestRegistrants" g ON g."id" = r."guest_registrant_id"
      LEFT JOIN "Invoices" i ON i."id" = r."invoice_id"
     WHERE r."deletedAt" IS NULL
       AND (${query.eventId ?? null}::bigint IS NULL OR r."event_id" = ${query.eventId ?? null})
       AND (${statuses}::int[] IS NULL OR r."status" = ANY(${statuses}::int[]))
     ORDER BY r."registered_at" DESC
     LIMIT ${query.limit} OFFSET ${offset}
  `);
};

export interface AttendeeRow {
  attendee_code: string;
  full_name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
  unit_price: Prisma.Decimal;
  food_preference: number | null;
  special_requirement: string | null;
  registration_code: string;
  status: number;
  booked_by: string | null;
  registrant_type: number;
  total: bigint;
}

/**
 * Who is going to attend — people, not companies.
 *
 * This is the list the association actually needs: a booking row saying
 * "ABC Pvt Ltd — 3" cannot be turned into badges, a catering count or a door
 * list. Deliberately not an attendance record: nothing here says who turned up.
 */
export const listAttendees = (
  db: Db,
  query: { eventId: bigint; statuses?: number[]; page: number; limit: number },
) => {
  const offset = (query.page - 1) * query.limit;
  const statuses = query.statuses && query.statuses.length > 0 ? query.statuses : null;

  return db.$queryRaw<AttendeeRow[]>(Prisma.sql`
    SELECT a."attendee_code", a."full_name", a."designation", a."email", a."phone",
           a."unit_price", a."food_preference", a."special_requirement",
           r."registration_code", r."status", r."registrant_type",
           COALESCE(m."company_name", g."company_name", g."full_name") AS booked_by,
           count(*) OVER () AS total
      FROM "EventRegistrationAttendees" a
      JOIN "EventRegistrations" r ON r."id" = a."registration_id"
      LEFT JOIN "Members" m ON m."id" = r."member_id"
      LEFT JOIN "GuestRegistrants" g ON g."id" = r."guest_registrant_id"
     WHERE r."event_id" = ${query.eventId}
       AND r."deletedAt" IS NULL
       AND (${statuses}::int[] IS NULL OR r."status" = ANY(${statuses}::int[]))
     ORDER BY COALESCE(m."company_name", g."company_name", g."full_name"), a."id"
     LIMIT ${query.limit} OFFSET ${offset}
  `);
};

export interface PaymentSubmissionRow {
  id: bigint;
  invoice_id: bigint;
  invoice_number: string;
  method: number;
  reference_no: string;
  amount: Prisma.Decimal;
  paid_on: Date;
  proof_path: string | null;
  status: number;
  rejection_reason: string | null;
  createdAt: Date;
  paid_by: string | null;
  event_title: string | null;
  registration_code: string | null;
  total: bigint;
}

/**
 * The payment claims queue.
 *
 * Oldest first, deliberately: this is a work queue, and a newest-first queue is
 * one where the claim somebody has been waiting on longest keeps sinking out of
 * sight.
 *
 * The payer's name is resolved from whichever side it lives on, and the booking
 * is joined optionally — a membership invoice has no booking, and this queue is
 * shared with those.
 */
export const listPaymentSubmissions = (
  db: Db,
  query: { statuses?: number[]; page: number; limit: number },
) => {
  const offset = (query.page - 1) * query.limit;
  const statuses = query.statuses && query.statuses.length > 0 ? query.statuses : null;

  return db.$queryRaw<PaymentSubmissionRow[]>(Prisma.sql`
    SELECT s."id", s."invoice_id", i."invoice_number", s."method", s."reference_no",
           s."amount", s."paid_on", s."proof_path", s."status", s."rejection_reason",
           s."createdAt",
           COALESCE(m."company_name", g."company_name", g."full_name") AS paid_by,
           e."title" AS event_title,
           r."registration_code",
           count(*) OVER () AS total
      FROM "PaymentSubmissions" s
      JOIN "Invoices" i ON i."id" = s."invoice_id"
      LEFT JOIN "Members" m ON m."id" = i."member_id"
      LEFT JOIN "GuestRegistrants" g ON g."id" = i."guest_registrant_id"
      LEFT JOIN "EventRegistrations" r ON r."invoice_id" = i."id" AND r."deletedAt" IS NULL
      LEFT JOIN "Events" e ON e."id" = r."event_id"
     WHERE (${statuses}::int[] IS NULL OR s."status" = ANY(${statuses}::int[]))
     ORDER BY s."createdAt" ASC
     LIMIT ${query.limit} OFFSET ${offset}
  `);
};
