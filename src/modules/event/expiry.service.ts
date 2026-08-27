import { InvoiceStatus } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { getNumericSetting, SETTING_KEYS } from '@helpers/settings';
import { logger } from '@logger/logger';
import { reminderDaysFor } from '@modules/event/event.constants';
import { touchedBySystem } from '@modules/event/actorColumns';
import * as notify from '@modules/event/notify';
import {
  CANCELLED_BY,
  DEFAULT_PAYMENT_HOLD_DAYS,
  REGISTRATION_STATUS,
} from '@modules/event/registration.constants';
import * as seats from '@modules/event/registration.repository';

/**
 * Releasing holds nobody paid for, and warning people before it happens.
 *
 * Both live in one nightly sweep because they are the same question asked of the
 * same rows: how long has this hold been waiting? Splitting them across two jobs
 * would let the reminder schedule and the release deadline drift apart, which is
 * exactly what deriving the reminders from the hold length exists to prevent.
 */

/** Whole days between two instants, floored. */
const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/**
 * Is today a reminder day for this hold?
 *
 * Derived from the hold length, so changing `event.payment_hold_days` moves the
 * reminders with it and there is no second setting to fall out of step.
 *
 * Never on the expiry day itself: the sweep releases the seats that same run,
 * and a warning the reader has no time to act on is worse than silence.
 */
export const dueReminders = (
  hold: { registered: Date; expires: Date },
  now: Date,
  holdDays: number,
): boolean => {
  const elapsed = daysBetween(hold.registered, now);

  if (now >= hold.expires) return false;

  return reminderDaysFor(holdDays).includes(elapsed);
};

/**
 * Release every hold whose deadline has passed.
 *
 * Each booking is its own transaction. One row failing — a constraint, a
 * deadlock — must not abandon the rest of the night's work, and a hold left
 * unreleased is a seat nobody can buy.
 *
 * `PAYMENT_UNDER_VERIFICATION` is deliberately not swept: its `expires_at` is
 * already null because the payer has done their part and the queue is the
 * association's to clear.
 */
export const releaseExpiredHolds = async (now = new Date()): Promise<number> => {
  const due = await prisma.eventRegistration.findMany({
    where: {
      deletedAt: null,
      status: { in: [REGISTRATION_STATUS.PENDING_APPROVAL, REGISTRATION_STATUS.PENDING_PAYMENT] },
      expires_at: { lt: now },
    },
    select: {
      id: true,
      event_id: true,
      attendee_count: true,
      invoice_id: true,
      status: true,
      user_id: true,
      member_id: true,
      contact_email: true,
      registration_code: true,
      expires_at: true,
      event: { select: { title: true, start_at: true } },
      invoice: { select: { invoice_number: true } },
    },
  });

  let released = 0;

  for (const hold of due) {
    try {
      await prisma.$transaction(async (tx) => {
        await seats.releaseSeats(tx, hold.event_id, hold.attendee_count);

        await tx.eventRegistration.update({
          where: { id: hold.id },
          data: {
            status: REGISTRATION_STATUS.EXPIRED,
            expires_at: null,
            cancelled_at: now,
            cancelled_by: CANCELLED_BY.SYSTEM,
            ...touchedBySystem(),
          },
        });

        // The bill goes with the booking. An ISSUED invoice for seats that no
        // longer exist would sit in the member's account looking payable, and
        // paying it would settle nothing.
        if (hold.invoice_id) {
          await tx.invoice.updateMany({
            where: {
              id: hold.invoice_id,
              status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.OVERDUE] },
            },
            data: { status: InvoiceStatus.CANCELLED },
          });
        }

        // Both halves matter to the reader: the seats are gone, and nothing is
        // owed. Told only the first, they ring the office about the invoice.
        await notify.notifyExpired(
          tx,
          {
            userId: hold.user_id,
            memberId: hold.member_id,
            toAddress: hold.contact_email,
            eventTitle: hold.event.title,
            eventDate: hold.event.start_at,
            registrationCode: hold.registration_code,
            seatCount: hold.attendee_count,
          },
          {
            invoice_number: hold.invoice?.invoice_number ?? null,
            expires_on: hold.expires_at ?? now,
          },
        );

        await writeAudit(tx, {
          action: AUDIT_ACTIONS.EVENT_REGISTRATION_EXPIRED,
          entityName: 'EventRegistrations',
          entityId: hold.id,
          actorType: ACTOR_TYPES.SYSTEM,
          before: { status: hold.status },
          after: { status: REGISTRATION_STATUS.EXPIRED, seats_released: hold.attendee_count },
          ip: null,
          userAgent: null,
          requestId: null,
        });
      });

      released += 1;
    } catch (error) {
      // Logged and skipped, never rethrown: one unreleasable hold must not stop
      // the sweep from freeing the rest.
      logger.error('event.expirySweepFailed', {
        registrationId: hold.id.toString(),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return released;
};

/**
 * Which holds should be warned tonight.
 *
 * Returned rather than emailed here so the notification wiring stays in one
 * place; the job hands these to the outbox.
 */
export const remindersDue = async (now = new Date()) => {
  const holdDays = await getNumericSetting(
    SETTING_KEYS.EVENT_PAYMENT_HOLD_DAYS,
    DEFAULT_PAYMENT_HOLD_DAYS,
  );

  const waiting = await prisma.eventRegistration.findMany({
    where: {
      deletedAt: null,
      status: REGISTRATION_STATUS.PENDING_PAYMENT,
      expires_at: { gt: now },
    },
    select: {
      id: true,
      registration_code: true,
      registered_at: true,
      expires_at: true,
      contact_email: true,
      total_amount: true,
      member_id: true,
      user_id: true,
      attendee_count: true,
      event: { select: { title: true, start_at: true } },
      invoice: { select: { invoice_number: true } },
    },
  });

  return waiting.filter((row) =>
    row.expires_at
      ? dueReminders({ registered: row.registered_at, expires: row.expires_at }, now, holdDays)
      : false,
  );
};

/**
 * Send tonight's reminders.
 *
 * Each is its own transaction, for the same reason the releases are: one
 * unsendable reminder must not stop the rest.
 *
 * Idempotence comes from the day arithmetic rather than a sent-flag: a hold is
 * due a reminder on specific elapsed days, so a second run on the same day
 * queues a second copy. The job runs hourly, so that would mean 24 emails a
 * day — which is why the outbox row is written only once per hold per day,
 * checked here before queueing.
 */
export const sendDueReminders = async (now = new Date()): Promise<number> => {
  const due = await remindersDue(now);
  let sent = 0;

  for (const hold of due) {
    try {
      const startOfToday = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );

      // Already reminded today? The job runs hourly; without this the reader
      // gets the same warning twenty-four times.
      const alreadySent = await prisma.notification.count({
        where: {
          template_code: 'event.payment_reminder',
          to_address: hold.contact_email,
          createdAt: { gte: startOfToday },
          payload_json: { path: ['registration_code'], equals: hold.registration_code },
        },
      });

      if (alreadySent > 0) continue;

      await prisma.$transaction(async (tx) => {
        await notify.notifyPaymentReminder(
          tx,
          {
            userId: hold.user_id,
            memberId: hold.member_id,
            toAddress: hold.contact_email,
            eventTitle: hold.event.title,
            eventDate: hold.event.start_at,
            registrationCode: hold.registration_code,
            seatCount: hold.attendee_count,
          },
          {
            invoice_number: hold.invoice?.invoice_number ?? '—',
            total_amount: hold.total_amount.toFixed(2),
            expires_on: hold.expires_at!,
          },
        );
      });

      sent += 1;
    } catch (error) {
      logger.error('event.reminderFailed', {
        registrationCode: hold.registration_code,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return sent;
};
