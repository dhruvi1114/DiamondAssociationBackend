import { InvoiceStatus, InvoiceType, Prisma } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { allocateInvoiceNumber, generateDocumentNumber } from '@helpers/documentNumber';
import { getNumericSetting, SETTING_KEYS } from '@helpers/settings';
import { EVENT_STATUS } from '@modules/event/event.constants';
import * as eventRepo from '@modules/event/event.repository';
import { priceBooking } from '@modules/event/registration.pricing';
import {
  CANCELLED_BY,
  DEFAULT_GRACE_DAYS,
  DEFAULT_PAYMENT_HOLD_DAYS,
  REGISTRANT_TYPE,
  REGISTRATION_STATUS,
  SEAT_HOLDING_STATUSES,
} from '@modules/event/registration.constants';
import * as seats from '@modules/event/registration.repository';
import { touchedByAdmin } from '@modules/event/actorColumns';
import { bookingLinkFor, issueEventAccessToken } from '@modules/event/registration.tokens';
import { AppError } from '@utils/appError';
import type { Db } from '@db/prisma';
import type { PriceTier } from '@modules/event/event.pricing';
import type {
  AttendeeInput,
  RegisterAsGuestInput,
  RegisterAsMemberInput,
} from '@modules/event/registration.types';

/**
 * Making a booking.
 *
 * Everything that must be true together happens in one transaction: the seats
 * are taken, the booking and its people are written, and the invoice is raised.
 * Any failure rolls all of it back, so there is no state where seats are held
 * with no booking, or a booking exists with no bill.
 */

export interface BookingActor {
  userId: bigint;
  memberId: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const conflict = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey });

const invalid = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.VALIDATION_ERROR, messageKey });

/**
 * `EVT` + year + calendar quarter + sequence, e.g. `EVT202603001`.
 *
 * No separator, matching `invoice_number` and `receipt_number`: the code goes
 * into emails, URLs and is read aloud to the office, and a slash in it survives
 * none of those well.
 */
const nextRegistrationCode = (tx: Db, on: Date): Promise<string> =>
  generateDocumentNumber(tx, {
    prefix: 'EVT',
    period: `${on.getUTCFullYear()}${String(Math.floor(on.getUTCMonth() / 3) + 1).padStart(2, '0')}`,
    separator: '',
  });

/**
 * Did this write lose the one-live-booking-per-company race?
 *
 * The partial unique index is the real guard, and it fires as a raw Prisma
 * error. Left alone the member sees a database message; translated here they see
 * "your company has already registered", which is both true and actionable.
 */
const isDuplicateBooking = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002' &&
  JSON.stringify(error.meta ?? {}).includes('member_id');

/**
 * Why a booking cannot be made right now, or null.
 *
 * Checked before any write, and each reason is its own message: "sold out" and
 * "registration closed" send the reader to different places, and a single
 * "cannot register" would send them to neither.
 */
const bookingRefusal = (
  event: {
    status: number;
    registration_opens_at: Date | null;
    registration_closes_at: Date | null;
  },
  now: Date,
): string | null => {
  if (event.status !== EVENT_STATUS.PUBLISHED) return 'event.notOpenForRegistration';
  if (event.registration_opens_at && now < event.registration_opens_at) {
    return 'event.registrationNotOpenYet';
  }
  if (event.registration_closes_at && now > event.registration_closes_at) {
    return 'event.registrationClosed';
  }

  return null;
};

/**
 * When this booking's seats go back if nobody pays.
 *
 * Read from settings on every booking rather than captured at boot, so changing
 * the hold applies to the next booking rather than the next deploy.
 */
export const holdDeadline = async (from: Date): Promise<Date> => {
  const days = await getNumericSetting(
    SETTING_KEYS.EVENT_PAYMENT_HOLD_DAYS,
    DEFAULT_PAYMENT_HOLD_DAYS,
  );

  return new Date(from.getTime() + days * 86_400_000);
};

/**
 * The invoice for a booking.
 *
 * Shared by the booking transaction and by approval, because an approval-on
 * event raises its invoice later — at the moment staff say yes — and the two
 * have to produce an identical bill. One line, quantity = delegates, so the
 * payer sees what they are paying for rather than a bare total.
 */
const raiseEventInvoice = async (
  tx: Db,
  input: {
    memberId: bigint | null;
    guestRegistrantId: bigint | null;
    issueDate: Date;
    dueDate: Date;
    eventTitle: string;
    tierName: string;
    seats: number;
    unitPrice: Prisma.Decimal;
    subtotal: Prisma.Decimal;
    taxRate: Prisma.Decimal;
    taxAmount: Prisma.Decimal;
    total: Prisma.Decimal;
  },
) =>
  tx.invoice.create({
    data: {
      invoice_number: await allocateInvoiceNumber(tx, input.issueDate),
      member_id: input.memberId,
      guest_registrant_id: input.guestRegistrantId,
      invoice_type: InvoiceType.EVENT,
      // Issued, not draft: the payer is told to pay it in the same breath as
      // being told their seats are held.
      status: InvoiceStatus.ISSUED,
      issue_date: input.issueDate,
      // Due the day the hold expires. A later due date would promise time the
      // seats are not actually going to wait.
      due_date: input.dueDate,
      subtotal: input.subtotal,
      tax_amount: input.taxAmount,
      total_amount: input.total,
      amount_paid: new Prisma.Decimal(0),
      balance_due: input.total,
      items: {
        create: [
          {
            description: `${input.eventTitle} — ${input.tierName} (${input.seats} delegate${input.seats === 1 ? '' : 's'})`,
            quantity: new Prisma.Decimal(input.seats),
            unit_price: input.unitPrice,
            tax_rate: input.taxRate,
            tax_amount: input.taxAmount,
            line_total: input.total,
            sort_order: 0,
          },
        ],
      },
    },
  });

/** A member company books seats for named colleagues. */
export const registerAsMember = async (
  slug: string,
  input: RegisterAsMemberInput,
  actor: BookingActor,
  now = new Date(),
) => {
  const event = await eventRepo.findMemberEventBySlug(prisma, slug);

  if (!event) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.notFound' });
  }

  const refusal = bookingRefusal(event, now);

  if (refusal) throw conflict(refusal);

  const member = await prisma.member.findFirst({
    where: { id: actor.memberId, deletedAt: null },
    include: {
      current_term: true,
      addresses: { where: { deletedAt: null } },
    },
  });

  if (!member) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.notFound' });
  }

  const graceDays = await getNumericSetting(SETTING_KEYS.MEMBERSHIP_GRACE_DAYS, DEFAULT_GRACE_DAYS);

  const priced = priceBooking({
    tiers: event.price_tiers as PriceTier[],
    on: now,
    seats: input.attendees.length,
    taxRate: event.tax_rate,
    membershipValidTill: member.current_term?.valid_till ?? null,
    graceDays,
  });

  // No tier covers today, so there is no price. Refusing beats inventing one.
  if (!priced) throw conflict('event.noPriceToday');

  const expiresAt = await holdDeadline(now);
  const address = member.addresses.find((row) => row.is_primary) ?? member.addresses[0];

  try {
    return await prisma.$transaction(async (tx) => {
      // Seats first. If the room is full this returns null, the transaction rolls
      // back, and no invoice was ever raised for a seat that does not exist.
      const taken = await seats.takeSeats(tx, event.id, input.attendees.length);

      if (taken === null) throw conflict('event.soldOut');

      /*
      Approval-on events wait before an invoice exists. That ordering is the
      whole point: a refusal then costs nothing to reverse, where refusing after
      billing would mean cancelling an invoice the member has already seen.
    */
      const needsApproval = event.requires_approval;
      const status = needsApproval
        ? REGISTRATION_STATUS.PENDING_APPROVAL
        : priced.isFree
          ? REGISTRATION_STATUS.CONFIRMED
          : REGISTRATION_STATUS.PENDING_PAYMENT;

      const invoice =
        needsApproval || priced.isFree
          ? null
          : await raiseEventInvoice(tx, {
              memberId: member.id,
              guestRegistrantId: null,
              issueDate: now,
              dueDate: expiresAt,
              eventTitle: event.title,
              tierName: priced.tier.name,
              seats: input.attendees.length,
              unitPrice: priced.unitPrice,
              subtotal: priced.subtotal,
              taxRate: event.tax_rate,
              taxAmount: priced.taxAmount,
              total: priced.total,
            });

      const registrationCode = await nextRegistrationCode(tx, now);

      const registration = await tx.eventRegistration.create({
        data: {
          event_id: event.id,
          registrant_type: REGISTRANT_TYPE.MEMBER,
          member_id: member.id,
          user_id: actor.userId,
          registration_code: registrationCode,
          status,
          attendee_count: input.attendees.length,
          price_tier_id: priced.tier.id,
          subtotal: priced.subtotal,
          tax_amount: priced.taxAmount,
          total_amount: priced.total,
          invoice_id: invoice?.id ?? null,
          // A confirmed booking holds its seats permanently, so it carries no
          // deadline; anything still waiting must have one.
          expires_at: status === REGISTRATION_STATUS.CONFIRMED ? null : expiresAt,
          terms_accepted_at: now,
          terms_version: event.terms_version,
          media_consent: input.media_consent,
          billing_company_name: member.company_name,
          gst_number: member.gst_number,
          pan_number: member.pan_number,
          iec_code: member.iec_code,
          billing_line1: input.billing_line1 ?? address?.line1 ?? null,
          billing_line2: input.billing_line2 ?? address?.line2 ?? null,
          billing_city: input.billing_city ?? address?.city ?? null,
          billing_state: input.billing_state ?? address?.state ?? null,
          billing_pincode: input.billing_pincode ?? address?.pincode ?? null,
          billing_country: address?.country ?? 'India',
          contact_name: input.contact_name ?? null,
          contact_email: input.contact_email ?? null,
          contact_phone: input.contact_phone ?? null,
          registered_at: now,
          created_by_user_id: actor.userId,
        },
      });

      // One row per person, each with its own code and the price frozen onto it.
      // The code is what goes in that person's confirmation email.
      let index = 0;

      for (const attendee of input.attendees) {
        index += 1;

        await tx.eventRegistrationAttendee.create({
          data: {
            registration_id: registration.id,
            member_user_id: attendee.member_user_id ? BigInt(attendee.member_user_id) : null,
            attendee_code: `${registrationCode}-${String(index).padStart(2, '0')}`,
            full_name: attendee.full_name,
            designation: attendee.designation ?? null,
            email: attendee.email ?? null,
            phone: attendee.phone ?? null,
            unit_price: priced.unitPrice,
            food_preference: event.collect_food_preference
              ? (attendee.food_preference ?? null)
              : null,
            id_type: event.collect_gov_id ? (attendee.id_type ?? null) : null,
            id_number: event.collect_gov_id ? (attendee.id_number ?? null) : null,
            special_requirement: attendee.special_requirement ?? null,
            created_by_user_id: actor.userId,
          },
        });
      }

      await writeAudit(tx, {
        action: AUDIT_ACTIONS.EVENT_REGISTERED,
        entityName: 'EventRegistrations',
        entityId: registration.id,
        actorType: ACTOR_TYPES.MEMBER,
        actorId: actor.userId,
        after: {
          event_id: event.id.toString(),
          seats: input.attendees.length,
          total: priced.total.toFixed(2),
          status,
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
      });

      return {
        id: registration.id.toString(),
        registration_code: registrationCode,
        status,
        seats: input.attendees.length,
        unit_price: priced.unitPrice.toFixed(2),
        subtotal: priced.subtotal.toFixed(2),
        tax_amount: priced.taxAmount.toFixed(2),
        total_amount: priced.total.toFixed(2),
        tier_name: priced.tier.name,
        audience: priced.audience,
        invoice_number: invoice?.invoice_number ?? null,
        expires_at: status === REGISTRATION_STATUS.CONFIRMED ? null : expiresAt,
      };
    });
  } catch (error) {
    if (isDuplicateBooking(error)) throw conflict('event.alreadyRegistered');

    throw error;
  }
};

/** Exported for the guest path and the tests to reuse. */
export const __internals = {
  bookingRefusal,
  invalid,
  attendeeCount: (a: AttendeeInput[]) => a.length,
};

/* --- staff decisions on an event that vets its attendees ------------------- */

export interface AdminActor {
  adminId: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const loadPendingApproval = async (id: bigint) => {
  const registration = await prisma.eventRegistration.findFirst({
    where: { id, deletedAt: null },
    include: { event: true },
  });

  if (!registration) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'event.registrationNotFound',
    });
  }

  if (registration.status !== REGISTRATION_STATUS.PENDING_APPROVAL) {
    throw conflict('event.registrationNotAwaitingApproval');
  }

  return registration;
};

/**
 * Staff say yes.
 *
 * The invoice is raised **now**, not at booking, and the hold clock restarts
 * from this moment. Both matter: if the clock had been running since the request
 * was made, an admin who took three days to decide would have spent three of the
 * payer's five, and the member would be chased for money they were never yet
 * asked for.
 */
export const approveRegistration = async (id: bigint, actor: AdminActor, now = new Date()) => {
  const registration = await loadPendingApproval(id);
  const expiresAt = await holdDeadline(now);
  const isFree = registration.total_amount.isZero();

  return prisma.$transaction(async (tx) => {
    const tier = registration.price_tier_id
      ? await tx.eventPriceTier.findUnique({ where: { id: registration.price_tier_id } })
      : null;

    const invoice = isFree
      ? null
      : await raiseEventInvoice(tx, {
          memberId: registration.member_id,
          guestRegistrantId: registration.guest_registrant_id,
          issueDate: now,
          dueDate: expiresAt,
          eventTitle: registration.event.title,
          // The tier the booking was priced at, not today's. The price was
          // frozen when they asked; approving does not re-price it.
          tierName: tier?.name ?? 'Registration',
          seats: registration.attendee_count,
          unitPrice: registration.subtotal.div(registration.attendee_count),
          subtotal: registration.subtotal,
          taxRate: registration.event.tax_rate,
          taxAmount: registration.tax_amount,
          total: registration.total_amount,
        });

    const updated = await tx.eventRegistration.update({
      where: { id },
      data: {
        status: isFree ? REGISTRATION_STATUS.CONFIRMED : REGISTRATION_STATUS.PENDING_PAYMENT,
        invoice_id: invoice?.id ?? null,
        expires_at: isFree ? null : expiresAt,
        approved_at: now,
        approved_by_admin_id: actor.adminId,
        ...touchedByAdmin(actor.adminId),
      },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_REGISTRATION_APPROVED,
      entityName: 'EventRegistrations',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.adminId,
      before: { status: REGISTRATION_STATUS.PENDING_APPROVAL },
      after: { status: updated.status, invoice_id: invoice?.id.toString() ?? null },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return {
      id: id.toString(),
      status: updated.status,
      invoice_number: invoice?.invoice_number ?? null,
      expires_at: updated.expires_at,
    };
  });
};

/**
 * Staff say no.
 *
 * The seats go back immediately, and the reason is mandatory — it is what the
 * applicant is told, and a refusal with no explanation is a phone call to the
 * office. Nothing financial has to be undone, because on an approval-on event
 * the invoice never existed.
 */
export const rejectRegistration = async (
  id: bigint,
  input: { reason: string },
  actor: AdminActor,
  now = new Date(),
) => {
  const registration = await loadPendingApproval(id);

  return prisma.$transaction(async (tx) => {
    await seats.releaseSeats(tx, registration.event_id, registration.attendee_count);

    const updated = await tx.eventRegistration.update({
      where: { id },
      data: {
        status: REGISTRATION_STATUS.REJECTED,
        rejection_reason: input.reason,
        // Cleared: the row is finished, and a deadline on a finished booking
        // would put it back in front of the expiry sweep every night.
        expires_at: null,
        cancelled_at: now,
        cancelled_by: CANCELLED_BY.ADMIN,
        ...touchedByAdmin(actor.adminId),
      },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_REGISTRATION_REJECTED,
      entityName: 'EventRegistrations',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.adminId,
      before: { status: REGISTRATION_STATUS.PENDING_APPROVAL },
      after: { status: updated.status, reason: input.reason },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { id: id.toString(), status: updated.status };
  });
};

/* --- reading the queues ---------------------------------------------------- */

/** Bookings, for the admin screens. `statuses` empty means every status. */
export const listRegistrations = async (query: {
  eventId?: bigint;
  statuses?: number[];
  page: number;
  limit: number;
}) => {
  const rows = await seats.listRegistrationsAdmin(prisma, query);

  return {
    rows: rows.map(({ total: _total, ...row }) => ({
      ...row,
      id: row.id.toString(),
      event_id: row.event_id.toString(),
      total_amount: row.total_amount.toFixed(2),
    })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
};

/**
 * Who is going to attend one event.
 *
 * Defaults to the bookings that actually hold a seat. An expired or rejected
 * booking has no one attending under it, and listing those people would inflate
 * every catering count taken off this screen.
 */
export const listAttendees = async (query: {
  eventId: bigint;
  statuses?: number[];
  page: number;
  limit: number;
}) => {
  const rows = await seats.listAttendees(prisma, {
    ...query,
    statuses: query.statuses && query.statuses.length > 0 ? query.statuses : SEAT_HOLDING_STATUSES,
  });

  return {
    rows: rows.map(({ total: _total, ...row }) => ({
      ...row,
      unit_price: row.unit_price.toFixed(2),
    })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
};

/* --- a non-member books a seat --------------------------------------------- */

/**
 * A guest registers for a public event.
 *
 * One seat, for themselves. A non-member booking a block of seats for other
 * people is a different thing — a company booking without a membership — and
 * nothing in the spec asks for it, so it is not invented here.
 *
 * A members-only event refuses outright, and does so as "not found": the guest
 * routes never reveal that a members-only event exists.
 *
 * The guest gets a login-free link to their booking, because they have no
 * account and still have to pay.
 */
export const registerAsGuest = async (
  slug: string,
  input: RegisterAsGuestInput,
  request: { ip: string | null; userAgent: string | null; requestId: string | null },
  now = new Date(),
) => {
  // The public finder already filters to PUBLISHED and PUBLIC, so a members-only
  // event is absent rather than forbidden.
  const event = await eventRepo.findPublicEventBySlug(prisma, slug);

  if (!event) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.notFound' });
  }

  const refusal = bookingRefusal(event, now);

  if (refusal) throw conflict(refusal);

  const graceDays = await getNumericSetting(SETTING_KEYS.MEMBERSHIP_GRACE_DAYS, DEFAULT_GRACE_DAYS);

  const priced = priceBooking({
    tiers: event.price_tiers as PriceTier[],
    on: now,
    seats: 1,
    taxRate: event.tax_rate,
    // No membership at all, so the non-member price applies whatever the grace
    // period says.
    membershipValidTill: null,
    graceDays,
  });

  if (!priced) throw conflict('event.noPriceToday');

  const expiresAt = await holdDeadline(now);

  return prisma.$transaction(async (tx) => {
    const taken = await seats.takeSeats(tx, event.id, 1);

    if (taken === null) throw conflict('event.soldOut');

    const guest = await tx.guestRegistrant.create({
      data: {
        full_name: input.full_name,
        designation: input.designation ?? null,
        company_name: input.company_name ?? null,
        email: input.email,
        phone: input.phone,
        gst_number: input.gst_number ?? null,
        pan_number: input.pan_number ?? null,
        line1: input.line1 ?? null,
        line2: input.line2 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        pincode: input.pincode ?? null,
        country: input.country,
      },
    });

    const needsApproval = event.requires_approval;
    const status = needsApproval
      ? REGISTRATION_STATUS.PENDING_APPROVAL
      : priced.isFree
        ? REGISTRATION_STATUS.CONFIRMED
        : REGISTRATION_STATUS.PENDING_PAYMENT;

    const invoice =
      needsApproval || priced.isFree
        ? null
        : await raiseEventInvoice(tx, {
            memberId: null,
            guestRegistrantId: guest.id,
            issueDate: now,
            dueDate: expiresAt,
            eventTitle: event.title,
            tierName: priced.tier.name,
            seats: 1,
            unitPrice: priced.unitPrice,
            subtotal: priced.subtotal,
            taxRate: event.tax_rate,
            taxAmount: priced.taxAmount,
            total: priced.total,
          });

    const registrationCode = await nextRegistrationCode(tx, now);

    const registration = await tx.eventRegistration.create({
      data: {
        event_id: event.id,
        registrant_type: REGISTRANT_TYPE.GUEST,
        guest_registrant_id: guest.id,
        registration_code: registrationCode,
        status,
        attendee_count: 1,
        price_tier_id: priced.tier.id,
        subtotal: priced.subtotal,
        tax_amount: priced.taxAmount,
        total_amount: priced.total,
        invoice_id: invoice?.id ?? null,
        expires_at: status === REGISTRATION_STATUS.CONFIRMED ? null : expiresAt,
        terms_accepted_at: now,
        terms_version: event.terms_version,
        media_consent: input.media_consent,
        billing_company_name: input.company_name ?? input.full_name,
        gst_number: input.gst_number ?? null,
        pan_number: input.pan_number ?? null,
        billing_line1: input.line1 ?? null,
        billing_line2: input.line2 ?? null,
        billing_city: input.city ?? null,
        billing_state: input.state ?? null,
        billing_pincode: input.pincode ?? null,
        billing_country: input.country,
        contact_name: input.full_name,
        contact_email: input.email,
        contact_phone: input.phone,
        registered_at: now,
      },
    });

    await tx.eventRegistrationAttendee.create({
      data: {
        registration_id: registration.id,
        attendee_code: `${registrationCode}-01`,
        full_name: input.full_name,
        designation: input.designation ?? null,
        email: input.email,
        phone: input.phone,
        unit_price: priced.unitPrice,
        food_preference: event.collect_food_preference ? (input.food_preference ?? null) : null,
        special_requirement: input.special_requirement ?? null,
      },
    });

    // Their only way back to this booking. Issued inside the transaction so a
    // link is never emailed for a booking that then rolled back.
    const token = await issueEventAccessToken(tx, registration.id, now);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_REGISTERED,
      entityName: 'EventRegistrations',
      entityId: registration.id,
      actorType: ACTOR_TYPES.SYSTEM,
      after: {
        event_id: event.id.toString(),
        guest_email: input.email,
        total: priced.total.toFixed(2),
        status,
      },
      ip: request.ip,
      userAgent: request.userAgent,
      requestId: request.requestId,
    });

    return {
      id: registration.id.toString(),
      registration_code: registrationCode,
      status,
      total_amount: priced.total.toFixed(2),
      tier_name: priced.tier.name,
      invoice_number: invoice?.invoice_number ?? null,
      expires_at: status === REGISTRATION_STATUS.CONFIRMED ? null : expiresAt,
      booking_link: bookingLinkFor(token),
    };
  });
};

/**
 * One booking, as the person who made it should see it.
 *
 * Narrower than the admin view on purpose: it carries what the booker needs to
 * act — what they owe, by when, and who is going — and nothing about the
 * association's own handling of it.
 */
export const getBookingSummary = async (id: bigint) => {
  const booking = await prisma.eventRegistration.findFirst({
    where: { id, deletedAt: null },
    include: {
      event: { select: { title: true, slug: true, start_at: true, venue_name: true, city: true } },
      attendees: { orderBy: { id: 'asc' } },
      invoice: {
        select: { invoice_number: true, status: true, total_amount: true, due_date: true },
      },
    },
  });

  if (!booking) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'event.registrationNotFound',
    });
  }

  return {
    registration_code: booking.registration_code,
    status: booking.status,
    event: booking.event,
    total_amount: booking.total_amount.toFixed(2),
    expires_at: booking.expires_at,
    invoice: booking.invoice
      ? {
          invoice_number: booking.invoice.invoice_number,
          status: booking.invoice.status,
          total_amount: booking.invoice.total_amount.toFixed(2),
          due_date: booking.invoice.due_date,
        }
      : null,
    attendees: booking.attendees.map((person) => ({
      attendee_code: person.attendee_code,
      full_name: person.full_name,
      designation: person.designation,
      unit_price: person.unit_price.toFixed(2),
    })),
  };
};

/**
 * The same list the screen shows, for export.
 *
 * Deliberately built on `listAttendees` rather than its own query. "The export
 * matches the on-screen filter" is a definition-of-done item for this module,
 * and the only way to keep that true as filters are added is for there to be one
 * query with two renderings — not two queries somebody has to remember to change
 * together.
 *
 * Paged through rather than read in one go: a large expo is thousands of
 * delegates, and a single unbounded read is how an export takes the API process
 * down with it.
 */
export const exportAttendees = async (query: { eventId: bigint; statuses?: number[] }) => {
  const PAGE = 500;
  const rows: Awaited<ReturnType<typeof listAttendees>>['rows'] = [];

  for (let page = 1; ; page += 1) {
    const chunk = await listAttendees({ ...query, page, limit: PAGE });

    rows.push(...chunk.rows);

    if (chunk.rows.length < PAGE) break;
  }

  return rows;
};
