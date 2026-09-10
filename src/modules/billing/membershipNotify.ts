import { NotificationChannel } from '@prisma/client';

import { queueNotification } from '@notifications/outbox';
import type { Db } from '@db/prisma';

/**
 * Telling a member what is happening to their membership payment.
 *
 * The member is not active while a claim is being checked, which is the right
 * rule and also the one that feels like nothing happened. These three messages
 * are what makes the wait legible: we have it, we confirmed it, or we could not
 * find it and here is why.
 *
 * Every send is queued inside the caller's transaction (ADR-010) where there is
 * one. A "your membership is active" email for a transaction that then rolled
 * back is worse than no email at all.
 */

export interface MembershipPaymentNotice {
  memberId: bigint;
  /** The primary contact's address. No address means no message — see `send`. */
  toAddress: string | null;
  companyName: string;
  invoiceNumber: string;
  amount: string;
}

const send = (
  db: Db,
  notice: MembershipPaymentNotice,
  templateCode: string,
  extra: Record<string, string> = {},
) => {
  /*
    No address is not an error worth failing the decision over. The claim was
    still filed, or the membership still activated, and a queued email that can
    never be delivered is worse than none.
  */
  if (!notice.toAddress) return Promise.resolve(null);

  return queueNotification(db, {
    templateCode,
    channel: NotificationChannel.EMAIL,
    memberId: notice.memberId,
    toAddress: notice.toAddress,
    payload: {
      name: notice.companyName,
      invoice_number: notice.invoiceNumber,
      amount: notice.amount,
      ...extra,
    },
  });
};

/** We have your details. Says what happens next, and roughly when. */
export const notifyClaimReceived = (db: Db, notice: MembershipPaymentNotice, referenceNo: string) =>
  send(db, notice, 'membership.payment_received', { reference_no: referenceNo });

/** Checked and confirmed — the membership is live. */
export const notifyClaimVerified = (db: Db, notice: MembershipPaymentNotice) =>
  send(db, notice, 'membership.payment_verified');

/**
 * We could not trace it.
 *
 * Carries the reason, because "rejected" with no reason is a phone call. Nothing
 * is lost — the invoice is still open and they can claim again once they have
 * the right reference.
 */
export const notifyClaimRejected = (db: Db, notice: MembershipPaymentNotice, reason: string) =>
  send(db, notice, 'membership.payment_rejected', { reason });
