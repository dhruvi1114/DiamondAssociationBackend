import { OtpPurpose } from '@prisma/client';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { getBooleanSetting, SETTING_KEYS } from '@helpers/settings';
import { consumeBookingOtp, issueBookingOtp } from '@modules/event/booking.otp';
import { signBookingLookupToken } from '@modules/event/booking.lookup.tokens';
import { AppError } from '@utils/appError';

/**
 * "Find my bookings" — every booking made with one email address (D-3).
 *
 * The OTP taken here is the whole of the authorisation, and it is taken NOW. That is
 * why this returns rows whose `email_verified_at` is NULL, including everything
 * booked before the OTP existed: proving the inbox at read time is proof enough to
 * read. Verification at BOOKING time is a stricter bar because it authorises an
 * unattended, durable write — attaching a booking to a member account.
 */

const notFound = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'common.notFound' });

/** 404 rather than 403 when the feature is off: an unbuilt page and a disabled one look alike. */
export const assertLookupEnabled = async (): Promise<void> => {
  if (!(await getBooleanSetting(SETTING_KEYS.BOOKING_LOOKUP_ENABLED, false))) throw notFound();
};

export const requestLookupOtp = async (email: string): Promise<void> => {
  await assertLookupEnabled();

  await prisma.$transaction(async (tx) => {
    await issueBookingOtp(tx, email, OtpPurpose.BOOKING_LOOKUP);
  });
};

export const lookupBookings = async (email: string, code: string) => {
  await assertLookupEnabled();

  await prisma.$transaction(async (tx) => {
    await consumeBookingOtp(tx, email, OtpPurpose.BOOKING_LOOKUP, code);
  });

  /*
    `EventRegistration` carries `guest_registrant_id` as a plain FK column with no
    Prisma relation field back to `GuestRegistrant` (unlike `Invoice`, which does
    have one) — so a nested `where: { guest_registrant: { email } }` is not
    available here without adding a relation to schema.prisma, which Task 8 is
    barred from doing. Each guest booking creates its OWN `GuestRegistrant` row
    (see `registration.service.ts`'s `tx.guestRegistrant.create`), so one address
    can own several of them over time; resolve those ids first, then filter
    `EventRegistration` by the plain column.
  */
  const guestRegistrants = await prisma.guestRegistrant.findMany({
    where: { email },
    select: { id: true },
  });

  const registrations = guestRegistrants.length
    ? await prisma.eventRegistration.findMany({
        where: {
          guest_registrant_id: { in: guestRegistrants.map((row) => row.id) },
          deletedAt: null,
        },
        orderBy: { registered_at: 'desc' },
        include: {
          event: {
            select: { title: true, slug: true, start_at: true, venue_name: true, city: true },
          },
          attendees: { orderBy: { id: 'asc' }, select: { attendee_code: true, full_name: true } },
          invoice: {
            select: {
              id: true,
              invoice_number: true,
              status: true,
              total_amount: true,
              due_date: true,
            },
          },
        },
      })
    : [];

  return {
    /*
      Issued only after the code is consumed, so it cannot be obtained by guessing.
      It carries the email and nothing else — every read behind it re-derives what is
      visible from that address rather than trusting an id in a path.
    */
    lookup_token: signBookingLookupToken(email),
    bookings: registrations.map((row) => ({
      id: row.id.toString(),
      registration_code: row.registration_code,
      status: row.status,
      attendee_count: row.attendee_count,
      total_amount: row.total_amount.toFixed(2),
      registered_at: row.registered_at,
      event: row.event,
      attendees: row.attendees,
      invoice: row.invoice
        ? {
            id: row.invoice.id.toString(),
            invoice_number: row.invoice.invoice_number,
            status: row.invoice.status,
            total_amount: row.invoice.total_amount.toFixed(2),
            due_date: row.invoice.due_date,
          }
        : null,
    })),
  };
};
