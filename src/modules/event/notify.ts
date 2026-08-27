import { NotificationChannel } from '@prisma/client';
import { queueNotification } from '@notifications/outbox';
import type { Db } from '@db/prisma';

/**
 * The messages an event booking sends.
 *
 * One module because the payloads overlap almost entirely, and because a
 * template placeholder that no caller fills renders as an empty line in a real
 * email — keeping the shapes together is what stops that happening.
 *
 * Every send is queued inside the caller's transaction (ADR-010). A confirmation
 * for a booking that then rolled back is worse than no confirmation: the reader
 * turns up to an event they are not registered for.
 */

/** Dates in emails are for people, not machines. */
const asDay = (date: Date | null | undefined): string =>
  date ? date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

export interface BookingNotice {
  /** Null for a guest — they have no login to attach the message to. */
  userId: bigint | null;
  memberId: bigint | null;
  toAddress: string | null;
  eventTitle: string;
  eventDate: Date;
  registrationCode: string;
  seatCount: number;
}

const base = (notice: BookingNotice): Record<string, string> => ({
  event_title: notice.eventTitle,
  event_date: asDay(notice.eventDate),
  registration_code: notice.registrationCode,
  seat_count: String(notice.seatCount),
});

const send = (
  db: Db,
  notice: BookingNotice,
  templateCode: string,
  payload: Record<string, string>,
  channel: NotificationChannel = NotificationChannel.EMAIL,
) =>
  queueNotification(db, {
    templateCode,
    channel,
    userId: notice.userId ?? undefined,
    memberId: notice.memberId ?? undefined,
    toAddress: notice.toAddress ?? undefined,
    payload: { ...base(notice), ...payload },
  });

/** Seats are held; here is the bill and the date they go if it is unpaid. */
export const notifyPendingPayment = async (
  db: Db,
  notice: BookingNotice,
  invoice: { invoice_number: string; total_amount: string; expires_on: Date },
) => {
  const payload = {
    invoice_number: invoice.invoice_number,
    total_amount: invoice.total_amount,
    expires_on: asDay(invoice.expires_on),
  };

  await send(db, notice, 'event.booking_pending_payment', payload);
  await send(db, notice, 'event.booking_pending_payment', payload, NotificationChannel.IN_APP);
};

/** The request is with the association. Nothing is payable yet — say so. */
export const notifyAwaitingApproval = (db: Db, notice: BookingNotice) =>
  send(db, notice, 'event.booking_awaiting_approval', {});

/** Approved. The hold clock starts now, so the date in this email is the real one. */
export const notifyApproved = (
  db: Db,
  notice: BookingNotice,
  invoice: { invoice_number: string; total_amount: string; expires_on: Date },
) =>
  send(db, notice, 'event.booking_approved', {
    invoice_number: invoice.invoice_number,
    total_amount: invoice.total_amount,
    expires_on: asDay(invoice.expires_on),
  });

/** Refused, with the reason. Nothing was charged — the reader needs to know that. */
export const notifyRejected = (db: Db, notice: BookingNotice, reason: string) =>
  send(db, notice, 'event.booking_rejected', { reason });

/** We have the payment details and are checking them. Nothing more to do. */
export const notifyPaymentReceived = (db: Db, notice: BookingNotice, referenceNo: string) =>
  send(db, notice, 'event.payment_received', { reference_no: referenceNo });

/** We could not trace it. The seats are still held — say until when. */
export const notifyPaymentRejected = (
  db: Db,
  notice: BookingNotice,
  input: { reason: string; expires_on: Date },
) =>
  send(db, notice, 'event.payment_rejected', {
    reason: input.reason,
    expires_on: asDay(input.expires_on),
  });

/**
 * Confirmed — one message per person, to their own address.
 *
 * Not one message to the booker listing everybody: the code is what gets each
 * person through the door, and a code sitting in a colleague's inbox is a code
 * the person holding it does not have.
 *
 * An attendee with no email address is skipped rather than failing the
 * confirmation; the booker still gets theirs, and the office has the list.
 */
export const notifyConfirmed = async (
  db: Db,
  notice: BookingNotice,
  input: {
    venue: string;
    attendees: { full_name: string; email: string | null; attendee_code: string }[];
  },
) => {
  for (const attendee of input.attendees) {
    if (!attendee.email) continue;

    await queueNotification(db, {
      templateCode: 'event.booking_confirmed',
      channel: NotificationChannel.EMAIL,
      userId: notice.userId ?? undefined,
      memberId: notice.memberId ?? undefined,
      toAddress: attendee.email,
      payload: {
        ...base(notice),
        attendee_name: attendee.full_name,
        attendee_code: attendee.attendee_code,
        venue: input.venue,
      },
    });
  }

  await send(db, notice, 'event.booking_confirmed', {}, NotificationChannel.IN_APP);
};

/** Still unpaid, and the seats go on this date. */
export const notifyPaymentReminder = (
  db: Db,
  notice: BookingNotice,
  invoice: { invoice_number: string; total_amount: string; expires_on: Date },
) =>
  send(db, notice, 'event.payment_reminder', {
    invoice_number: invoice.invoice_number,
    total_amount: invoice.total_amount,
    expires_on: asDay(invoice.expires_on),
  });

/** The seats are gone and nothing is owed. Both halves matter. */
export const notifyExpired = (
  db: Db,
  notice: BookingNotice,
  input: { invoice_number: string | null; expires_on: Date },
) =>
  send(db, notice, 'event.booking_expired', {
    invoice_number: input.invoice_number ?? '—',
    expires_on: asDay(input.expires_on),
  });

/** The event is off and the money is coming back. */
export const notifyEventCancelledWithRefund = (
  db: Db,
  notice: BookingNotice,
  input: { reason: string; total_amount: string; refund_number: string },
) =>
  send(db, notice, 'event.cancelled_refund', {
    reason: input.reason,
    total_amount: input.total_amount,
    refund_number: input.refund_number,
  });

/** The event is off, and nothing was ever taken. Both halves matter. */
export const notifyEventCancelledUnpaid = (db: Db, notice: BookingNotice, reason: string) =>
  send(db, notice, 'event.cancelled_unpaid', { reason });

/**
 * The booker cancelled their own seats.
 *
 * `refund_note` carries the money sentence, because the answer differs: an
 * unpaid booking owes nothing, and a paid one gets nothing back under the
 * association's policy. Saying so here is what stops the follow-up email asking.
 */
export const notifyBookingCancelledByMember = (db: Db, notice: BookingNotice, refundNote: string) =>
  send(db, notice, 'event.booking_cancelled_by_member', { refund_note: refundNote });
