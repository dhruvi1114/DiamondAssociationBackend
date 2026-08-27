import { Prisma } from '@prisma/client';
import { EVENT_STATUS } from '@modules/event/event.constants';
import { REGISTRATION_STATUS, SUBMISSION_STATUS } from '@modules/event/registration.constants';
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
  /** The company's own email and phone, or the guest's — whoever the booking is billed to. */
  contact_email: string | null;
  contact_phone: string | null;
  /** Primary-address city for a member, the typed city for a guest. */
  city: string | null;
  approved_at: Date | null;
  approved_by: string | null;
  rejected_at: Date | null;
  rejected_by: string | null;
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
  query: {
    eventId?: bigint;
    statuses?: number[];
    search?: string | undefined;
    page: number;
    limit: number;
  },
) => {
  const offset = (query.page - 1) * query.limit;
  const statuses = query.statuses && query.statuses.length > 0 ? query.statuses : null;
  /*
    Matched in SQL, never after fetching. A client-side filter can only see the
    twenty rows already on screen, so it reports "no matches" for a booking
    sitting on page four — the same reason the member list searches server-side.
  */
  const search = query.search ? `%${query.search}%` : null;

  return db.$queryRaw<AdminRegistrationRow[]>(Prisma.sql`
    SELECT r."id", r."registration_code", r."event_id", e."title" AS event_title,
           r."registrant_type", r."status", r."attendee_count", r."total_amount",
           r."registered_at", r."expires_at",
           COALESCE(m."company_name", g."company_name", g."full_name") AS booked_by,
           /*
             Who do I ring about THIS booking — one column, whatever kind of
             registrant it is.

             The booking's own contact comes first. Whoever filled the form was
             asked where correspondence about this booking should go, and that
             is not always the login that owns the company: a firm books through
             its accounts address and wants the confirmation there.

             This used to start at the member's login email, which meant the list
             and the detail page answered the same question differently — the
             list showing the company's address and the detail the booking's.
             Same COALESCE on both now; a screen that disagrees with the screen
             it links to is worse than either answer alone.
           */
           COALESCE(r."contact_email", u."email", g."email") AS contact_email,
           COALESCE(r."contact_phone", u."phone", g."phone") AS contact_phone,
           COALESCE(addr."city", g."city") AS city,
           r."approved_at",
           app."full_name" AS approved_by,
           -- Rejection has no dedicated columns: the reject path writes
           -- cancelled_at and stamps updated_by_admin_id, and REJECTED is
           -- terminal, so nothing touches the row afterwards to overwrite it.
           -- Guarded by the status so a plain cancellation never reads as one.
           CASE WHEN r."status" = ${REGISTRATION_STATUS.REJECTED} THEN r."cancelled_at" END AS rejected_at,
           CASE WHEN r."status" = ${REGISTRATION_STATUS.REJECTED} THEN rej."full_name" END AS rejected_by,
           i."invoice_number",
           count(*) OVER () AS total
      FROM "EventRegistrations" r
      JOIN "Events" e ON e."id" = r."event_id"
      LEFT JOIN "Members" m ON m."id" = r."member_id"
      LEFT JOIN "Users" u ON u."id" = m."primary_user_id"
      LEFT JOIN "GuestRegistrants" g ON g."id" = r."guest_registrant_id"
      LEFT JOIN "Invoices" i ON i."id" = r."invoice_id"
      LEFT JOIN "AdminUsers" app ON app."id" = r."approved_by_admin_id"
      LEFT JOIN "AdminUsers" rej ON rej."id" = r."updated_by_admin_id"
      -- LATERAL so the city comes off ONE address row rather than whichever the
      -- planner reached first — same reason the member list does it this way.
      LEFT JOIN LATERAL (
        SELECT a."city"
          FROM "MemberAddresses" a
         WHERE a."member_id" = m."id" AND a."deletedAt" IS NULL
         ORDER BY a."is_primary" DESC, a."id" ASC
         LIMIT 1
      ) addr ON TRUE
     WHERE r."deletedAt" IS NULL
       AND (${query.eventId ?? null}::bigint IS NULL OR r."event_id" = ${query.eventId ?? null})
       AND (${statuses}::int[] IS NULL OR r."status" = ANY(${statuses}::int[]))
       -- The six things staff paste into a search box: the booking reference,
       -- the invoice it raised, who booked, how to reach them, and the event.
       -- Every one of them is a column the screen already shows, so a hit is
       -- always visible in the row it returns.
       AND (${search}::text IS NULL
            OR r."registration_code" ILIKE ${search}
            OR i."invoice_number" ILIKE ${search}
            OR e."title" ILIKE ${search}
            OR m."company_name" ILIKE ${search}
            OR g."company_name" ILIKE ${search}
            OR g."full_name" ILIKE ${search}
            OR r."contact_email" ILIKE ${search}
            OR u."email" ILIKE ${search}
            OR g."email" ILIKE ${search}
            OR r."contact_phone" ILIKE ${search}
            OR u."phone" ILIKE ${search}
            OR g."phone" ILIKE ${search})
     ORDER BY r."registered_at" DESC
     LIMIT ${query.limit} OFFSET ${offset}
  `);
};

/**
 * One booking, everything the detail page needs about it.
 *
 * The same joins as the list, plus the parts a row has no room for: the frozen
 * billing snapshot, the event's own dates and venue, and the invoice's state.
 * One statement rather than five lookups — a detail page that fires a query per
 * card is the N+1 the list already refuses to make (ADR-005).
 */
export interface RegistrationDetailRow {
  id: bigint;
  registration_code: string;
  event_id: bigint;
  event_title: string;
  event_slug: string;
  event_start_at: Date;
  event_end_at: Date;
  event_venue_name: string | null;
  event_city: string | null;
  /** Whether THIS event gates bookings on a decision — the shape of its journey. */
  event_requires_approval: boolean;
  registrant_type: number;
  status: number;
  attendee_count: number;
  subtotal: Prisma.Decimal;
  tax_amount: Prisma.Decimal;
  total_amount: Prisma.Decimal;
  registered_at: Date;
  expires_at: Date | null;
  booked_by: string | null;
  member_code: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  /** The member login's own address, shown beside the booking's when they differ. */
  account_email: string | null;
  account_phone: string | null;
  city: string | null;
  tier_name: string | null;
  billing_company_name: string | null;
  gst_number: string | null;
  billing_line1: string | null;
  billing_line2: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_pincode: string | null;
  billing_country: string | null;
  terms_accepted_at: Date;
  terms_version: string;
  media_consent: boolean;
  approved_at: Date | null;
  approved_by: string | null;
  rejection_reason: string | null;
  rejected_at: Date | null;
  rejected_by: string | null;
  cancelled_at: Date | null;
  cancelled_by: number | null;
  invoice_id: bigint | null;
  invoice_number: string | null;
  invoice_status: string | null;
  invoice_total: Prisma.Decimal | null;
  invoice_due_date: Date | null;
}

export const findRegistrationDetail = async (
  db: Db,
  id: bigint,
): Promise<RegistrationDetailRow | null> => {
  const rows = await db.$queryRaw<RegistrationDetailRow[]>(Prisma.sql`
    SELECT r."id", r."registration_code", r."event_id",
           e."title" AS event_title, e."slug" AS event_slug,
           e."start_at" AS event_start_at, e."end_at" AS event_end_at,
           e."venue_name" AS event_venue_name, e."city" AS event_city,
           e."requires_approval" AS event_requires_approval,
           r."registrant_type", r."status", r."attendee_count",
           r."subtotal", r."tax_amount", r."total_amount",
           r."registered_at", r."expires_at",
           COALESCE(m."company_name", g."company_name", g."full_name") AS booked_by,
           m."member_code",
           -- The booking's own contact first: whoever filled the form said who
           -- to ring about THIS booking, and that is not always the company's
           -- standing contact.
           COALESCE(r."contact_name", g."full_name") AS contact_name,
           COALESCE(r."contact_email", u."email", g."email") AS contact_email,
           COALESCE(r."contact_phone", u."phone", g."phone") AS contact_phone,
           -- The company's standing address, unresolved. Shown beside the
           -- booking's contact when the two differ, so "why does this say a
           -- different email from the member record" is answered on the page
           -- rather than by opening the member record to compare.
           u."email" AS account_email,
           u."phone" AS account_phone,
           COALESCE(addr."city", g."city") AS city,
           t."name" AS tier_name,
           r."billing_company_name", r."gst_number",
           r."billing_line1", r."billing_line2", r."billing_city",
           r."billing_state", r."billing_pincode", r."billing_country",
           r."terms_accepted_at", r."terms_version", r."media_consent",
           r."approved_at",
           app."full_name" AS approved_by,
           r."rejection_reason",
           -- Rejection reuses cancelled_at and updated_by_admin_id, guarded by
           -- the status so an ordinary cancellation never reads as a refusal.
           CASE WHEN r."status" = ${REGISTRATION_STATUS.REJECTED} THEN r."cancelled_at" END AS rejected_at,
           CASE WHEN r."status" = ${REGISTRATION_STATUS.REJECTED} THEN rej."full_name" END AS rejected_by,
           r."cancelled_at", r."cancelled_by",
           r."invoice_id", i."invoice_number", i."status" AS invoice_status,
           i."total_amount" AS invoice_total, i."due_date" AS invoice_due_date
      FROM "EventRegistrations" r
      JOIN "Events" e ON e."id" = r."event_id"
      LEFT JOIN "Members" m ON m."id" = r."member_id"
      LEFT JOIN "Users" u ON u."id" = m."primary_user_id"
      LEFT JOIN "GuestRegistrants" g ON g."id" = r."guest_registrant_id"
      LEFT JOIN "Invoices" i ON i."id" = r."invoice_id"
      LEFT JOIN "EventPriceTiers" t ON t."id" = r."price_tier_id"
      LEFT JOIN "AdminUsers" app ON app."id" = r."approved_by_admin_id"
      LEFT JOIN "AdminUsers" rej ON rej."id" = r."updated_by_admin_id"
      LEFT JOIN LATERAL (
        SELECT a."city"
          FROM "MemberAddresses" a
         WHERE a."member_id" = m."id" AND a."deletedAt" IS NULL
         ORDER BY a."is_primary" DESC, a."id" ASC
         LIMIT 1
      ) addr ON TRUE
     WHERE r."id" = ${id} AND r."deletedAt" IS NULL
  `);

  return rows[0] ?? null;
};

/** The people on one booking, in the order they were entered. */
export const listAttendeesForRegistration = (db: Db, registrationId: bigint) =>
  db.eventRegistrationAttendee.findMany({
    where: { registration_id: registrationId },
    orderBy: { id: 'asc' },
    select: {
      attendee_code: true,
      full_name: true,
      designation: true,
      email: true,
      phone: true,
      unit_price: true,
      food_preference: true,
      special_requirement: true,
    },
  });

/** Every payment claim filed against this booking's invoice, newest last. */
export const listSubmissionsForInvoice = (db: Db, invoiceId: bigint) =>
  db.paymentSubmission.findMany({
    where: { invoice_id: invoiceId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      method: true,
      reference_no: true,
      amount: true,
      paid_on: true,
      status: true,
      rejection_reason: true,
      createdAt: true,
      verified_at: true,
    },
  });

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
  /** The person who filed the claim, as distinct from the company it is billed to. */
  claimed_by: string | null;
  /** The staff account that decided, split by which way they decided. */
  verified_by: string | null;
  verified_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
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
  query: {
    statuses?: number[];
    methods?: number[];
    search?: string | undefined;
    page: number;
    limit: number;
  },
) => {
  const offset = (query.page - 1) * query.limit;
  const statuses = query.statuses && query.statuses.length > 0 ? query.statuses : null;
  const methods = query.methods && query.methods.length > 0 ? query.methods : null;
  const search = query.search ? `%${query.search}%` : null;

  return db.$queryRaw<PaymentSubmissionRow[]>(Prisma.sql`
    SELECT s."id", s."invoice_id", i."invoice_number", s."method", s."reference_no",
           s."amount", s."paid_on", s."proof_path", s."status", s."rejection_reason",
           s."createdAt",
           COALESCE(m."company_name", g."company_name", g."full_name") AS paid_by,
           -- Who filed it, not who it is billed to. On a company with several
           -- team logins those are different people, and the one to ring about a
           -- mistyped reference is the one who typed it.
           COALESCE(su."full_name", sg."full_name") AS claimed_by,
           -- One pair of columns on the table records the decision either way, so
           -- the status is what says which way it went. Split into two here
           -- because "who confirmed this" and "who could not find it" are asked
           -- on different days for different reasons.
           CASE WHEN s."status" = ${SUBMISSION_STATUS.VERIFIED} THEN va."full_name" END AS verified_by,
           CASE WHEN s."status" = ${SUBMISSION_STATUS.VERIFIED} THEN s."verified_at" END AS verified_at,
           CASE WHEN s."status" = ${SUBMISSION_STATUS.REJECTED} THEN va."full_name" END AS rejected_by,
           CASE WHEN s."status" = ${SUBMISSION_STATUS.REJECTED} THEN s."verified_at" END AS rejected_at,
           e."title" AS event_title,
           r."registration_code",
           count(*) OVER () AS total
      FROM "PaymentSubmissions" s
      JOIN "Invoices" i ON i."id" = s."invoice_id"
      LEFT JOIN "Members" m ON m."id" = i."member_id"
      LEFT JOIN "GuestRegistrants" g ON g."id" = i."guest_registrant_id"
      LEFT JOIN "Users" su ON su."id" = s."submitted_by_user_id"
      LEFT JOIN "GuestRegistrants" sg ON sg."id" = s."submitted_by_guest_id"
      LEFT JOIN "AdminUsers" va ON va."id" = s."verified_by_admin_id"
      LEFT JOIN "EventRegistrations" r ON r."invoice_id" = i."id" AND r."deletedAt" IS NULL
      LEFT JOIN "Events" e ON e."id" = r."event_id"
     WHERE (${statuses}::int[] IS NULL OR s."status" = ANY(${statuses}::int[]))
       AND (${methods}::int[] IS NULL OR s."method" = ANY(${methods}::int[]))
       -- The bank reference first: a submission is almost always looked up from
       -- a statement line, and that number is the only thing the two records
       -- have in common.
       AND (${search}::text IS NULL
            OR s."reference_no" ILIKE ${search}
            OR i."invoice_number" ILIKE ${search}
            OR r."registration_code" ILIKE ${search}
            OR e."title" ILIKE ${search}
            OR m."company_name" ILIKE ${search}
            OR g."company_name" ILIKE ${search}
            OR g."full_name" ILIKE ${search}
            OR su."full_name" ILIKE ${search}
            OR sg."full_name" ILIKE ${search})
     ORDER BY s."createdAt" ASC
     LIMIT ${query.limit} OFFSET ${offset}
  `);
};
