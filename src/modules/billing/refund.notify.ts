import { NotificationChannel } from '@prisma/client';

import { queueNotification } from '@notifications/outbox';
import type { RefundRow } from '@modules/billing/refund.repository';
import type { Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

/**
 * Telling the payer what happened to their money.
 *
 * Three of the four decisions are sent. `fail` is not: a bounced transfer is
 * the association's problem to fix, and "your refund failed" with nothing the
 * reader can do about it generates a phone call and no action. They hear again
 * when it completes.
 */

/**
 * Who to write to, and under which company.
 *
 * A member is addressed at their primary contact — every company has one — and
 * a guest at the address they booked with. `to_address` is required for email;
 * the outbox does not look one up from `member_id`, so it is resolved here
 * rather than left for a channel to fail on at send time.
 */
const addressee = (refund: RefundRow) => {
  const member = refund.payment.member;

  if (member) {
    return {
      memberId: member.id,
      toAddress: member.contacts[0]?.email ?? undefined,
      name: member.company_name,
    };
  }

  const guest = refund.payment.guest_registrant;

  return {
    memberId: undefined,
    toAddress: guest?.email,
    name: guest?.company_name ?? guest?.full_name ?? 'there',
  };
};

const send = (db: Db, refund: RefundRow, templateCode: string, extra: Record<string, string>) => {
  const to = addressee(refund);

  // No address is not an error worth failing the decision over: the refund still
  // happened, and a queued email that can never be delivered is worse than none.
  if (!to.toAddress) return Promise.resolve(null);

  return queueNotification(db, {
    templateCode,
    channel: NotificationChannel.EMAIL,
    memberId: to.memberId,
    toAddress: to.toAddress,
    payload: {
      name: to.name,
      refund_number: refund.refund_number,
      amount: refund.amount.toFixed(2),
      invoice_number: refund.payment.invoice.invoice_number,
      ...extra,
    },
  });
};

/** Released for sending. Deliberately does not promise a date the money lands. */
export const notifyRefundApproved = (db: Db, refund: RefundRow) =>
  send(db, refund, 'refund.approved', {});

/** The money is on its way back, with the reference to quote at their bank. */
export const notifyRefundCompleted = (db: Db, refund: RefundRow, reference: string) =>
  send(db, refund, 'refund.completed', { reference });

/** Refused. The reason is the whole message — without it this is just a "no". */
export const notifyRefundRejected = (db: Db, refund: RefundRow, reason: string) =>
  send(db, refund, 'refund.rejected', { reason });
