import { InvoiceStatus, Prisma } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { nextPaymentNumber, nextReceiptNumber } from '@modules/billing/numbering';
import { MANUAL_PROVIDER, PAYMENT_STATUS } from '@modules/billing/payment.constants';
import {
  REGISTRATION_STATUS,
  SUBMISSION_METHOD,
  SUBMISSION_STATUS,
} from '@modules/event/registration.constants';
import * as notify from '@modules/event/notify';
import * as seats from '@modules/event/registration.repository';
import { holdDeadline } from '@modules/event/registration.service';
import { touchedByAdmin, touchedByMember } from '@modules/event/actorColumns';
import { AppError } from '@utils/appError';
import type { AdminActor } from '@modules/event/registration.service';

/**
 * Offline payment: the payer claims, staff confirm.
 *
 * This is what stands in for a gateway. The two halves are deliberately separate
 * records — a `PaymentSubmission` is what somebody says happened, a `Payment` is
 * what the association has checked. Collapsing them would make an unverified
 * claim look identical to money in the bank.
 */

const conflict = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey });

const notFound = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey });

/** The submission methods the payer may claim. Cash is staff-recorded, not claimed. */
export interface SubmitPaymentInput {
  method: number;
  reference_no: string;
  amount: number;
  paid_on: Date;
  proof_path?: string | null;
}

/**
 * "I have paid."
 *
 * The hold clock **stops** here by clearing `expires_at`: the payer has done
 * their part, and letting the sweep release their seats while staff work through
 * the queue would punish them for the association's response time.
 */
export const submitPayment = async (
  registrationId: bigint,
  input: SubmitPaymentInput,
  actor: {
    userId: bigint | null;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  },
) => {
  const registration = await prisma.eventRegistration.findFirst({
    where: { id: registrationId, deletedAt: null },
    include: { invoice: true, event: { select: { title: true, start_at: true } } },
  });

  if (!registration) throw notFound('event.registrationNotFound');
  if (registration.status !== REGISTRATION_STATUS.PENDING_PAYMENT) {
    throw conflict('event.notAwaitingPayment');
  }
  if (!registration.invoice) throw conflict('event.noInvoiceToPay');

  return prisma.$transaction(async (tx) => {
    const submission = await tx.paymentSubmission.create({
      data: {
        invoice_id: registration.invoice!.id,
        submitted_by_user_id: actor.userId,
        method: input.method,
        reference_no: input.reference_no,
        amount: new Prisma.Decimal(input.amount),
        paid_on: input.paid_on,
        proof_path: input.proof_path ?? null,
        status: SUBMISSION_STATUS.PENDING,
        created_by_user_id: actor.userId,
      },
    });

    await tx.eventRegistration.update({
      where: { id: registrationId },
      data: {
        status: REGISTRATION_STATUS.PAYMENT_UNDER_VERIFICATION,
        // The clock stops. The payer has done their part; the queue is the
        // association's problem, not a reason to lose their seats.
        expires_at: null,
        ...touchedByMember(actor.userId),
      },
    });

    await notify.notifyPaymentReceived(
      tx,
      {
        userId: registration.user_id,
        memberId: registration.member_id,
        toAddress: registration.contact_email,
        eventTitle: registration.event.title,
        eventDate: registration.event.start_at,
        registrationCode: registration.registration_code,
        seatCount: registration.attendee_count,
      },
      input.reference_no,
    );

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PAYMENT_SUBMITTED,
      entityName: 'PaymentSubmissions',
      entityId: submission.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: actor.userId ?? undefined,
      after: { reference_no: input.reference_no, amount: input.amount },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return {
      id: submission.id.toString(),
      status: SUBMISSION_STATUS.PENDING,
      registration_status: REGISTRATION_STATUS.PAYMENT_UNDER_VERIFICATION,
    };
  });
};

const loadPendingSubmission = async (id: bigint) => {
  const submission = await prisma.paymentSubmission.findFirst({
    where: { id },
    include: { invoice: true },
  });

  if (!submission) throw notFound('event.submissionNotFound');
  if (submission.status !== SUBMISSION_STATUS.PENDING) throw conflict('event.submissionDecided');

  return submission;
};

/**
 * Staff confirm the money landed.
 *
 * Invoice → payment → receipt → booking confirmed, in one transaction.
 *
 * Deliberately NOT the membership payment path. That one also flips a PENDING
 * member to ACTIVE and activates their term — correct when they pay their
 * membership invoice, badly wrong when an applicant who has not yet joined pays
 * for a seat at a seminar.
 */
export const verifyPayment = async (id: bigint, actor: AdminActor, now = new Date()) => {
  const submission = await loadPendingSubmission(id);
  const invoice = submission.invoice;

  if (invoice.status === InvoiceStatus.PAID) throw conflict('member.invoiceAlreadyPaid');
  if (invoice.status === InvoiceStatus.CANCELLED) throw conflict('member.invoiceNotPayable');

  return prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: InvoiceStatus.PAID,
        amount_paid: invoice.total_amount,
        balance_due: new Prisma.Decimal(0),
      },
    });

    const payment = await tx.payment.create({
      data: {
        payment_number: await nextPaymentNumber(tx, now),
        invoice_id: invoice.id,
        member_id: invoice.member_id,
        guest_registrant_id: invoice.guest_registrant_id,
        amount: invoice.total_amount,
        method: submission.method,
        provider: MANUAL_PROVIDER,
        status: PAYMENT_STATUS.SUCCESS,
        paid_at: now,
        recorded_by_admin_id: actor.adminId,
        created_by_admin_id: actor.adminId,
      },
    });

    // Whoever the invoice names. A guest who pays gets a receipt like anyone
    // else — they have paid the association the same money for the same seat.
    const receipt = await tx.receipt.create({
      data: {
        receipt_number: await nextReceiptNumber(tx, now),
        invoice_id: invoice.id,
        payment_id: payment.id,
        member_id: invoice.member_id,
        guest_registrant_id: invoice.guest_registrant_id,
        amount: invoice.total_amount,
      },
    });

    await tx.paymentSubmission.update({
      where: { id },
      data: {
        status: SUBMISSION_STATUS.VERIFIED,
        verified_by_admin_id: actor.adminId,
        verified_at: now,
        payment_id: payment.id,
        ...touchedByAdmin(actor.adminId),
      },
    });

    const registration = await tx.eventRegistration.findFirst({
      where: { invoice_id: invoice.id, deletedAt: null },
      include: {
        attendees: { select: { full_name: true, email: true, attendee_code: true } },
        event: { select: { title: true, start_at: true, venue_name: true, city: true } },
      },
    });

    if (registration) {
      await tx.eventRegistration.update({
        where: { id: registration.id },
        data: {
          status: REGISTRATION_STATUS.CONFIRMED,
          // Confirmed seats are permanent — nothing left to expire.
          expires_at: null,
          ...touchedByAdmin(actor.adminId),
        },
      });
    }

    if (registration) {
      // One message per person, to their own address. The code is what gets them
      // through the door, and a code in a colleague's inbox is a code the person
      // holding it does not have.
      await notify.notifyConfirmed(
        tx,
        {
          userId: registration.user_id,
          memberId: registration.member_id,
          toAddress: registration.contact_email,
          eventTitle: registration.event.title,
          eventDate: registration.event.start_at,
          registrationCode: registration.registration_code,
          seatCount: registration.attendee_count,
        },
        {
          venue: [registration.event.venue_name, registration.event.city]
            .filter(Boolean)
            .join(', '),
          attendees: registration.attendees,
        },
      );
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PAYMENT_VERIFIED,
      entityName: 'PaymentSubmissions',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.adminId,
      after: {
        payment_number: payment.payment_number,
        receipt_number: receipt.receipt_number,
        invoice_number: invoice.invoice_number,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return {
      id: id.toString(),
      payment_number: payment.payment_number,
      receipt_number: receipt.receipt_number,
      registration_status: registration ? REGISTRATION_STATUS.CONFIRMED : null,
    };
  });
};

/**
 * Staff cannot find the money.
 *
 * The seats stay held and the clock restarts, so the payer has a full window to
 * correct the reference rather than losing their booking to a typo. The reason
 * is mandatory: "UTR not found in our statement" tells them what to do next,
 * where a bare rejection tells them only to telephone.
 */
export const rejectPayment = async (
  id: bigint,
  input: { reason: string },
  actor: AdminActor,
  now = new Date(),
) => {
  const submission = await loadPendingSubmission(id);
  const expiresAt = await holdDeadline(now);

  return prisma.$transaction(async (tx) => {
    await tx.paymentSubmission.update({
      where: { id },
      data: {
        status: SUBMISSION_STATUS.REJECTED,
        rejection_reason: input.reason,
        verified_by_admin_id: actor.adminId,
        verified_at: now,
        ...touchedByAdmin(actor.adminId),
      },
    });

    const registration = await tx.eventRegistration.findFirst({
      where: { invoice_id: submission.invoice_id, deletedAt: null },
      include: { event: { select: { title: true, start_at: true } } },
    });

    if (registration) {
      await tx.eventRegistration.update({
        where: { id: registration.id },
        data: {
          status: REGISTRATION_STATUS.PENDING_PAYMENT,
          expires_at: expiresAt,
          ...touchedByAdmin(actor.adminId),
        },
      });

      await notify.notifyPaymentRejected(
        tx,
        {
          userId: registration.user_id,
          memberId: registration.member_id,
          toAddress: registration.contact_email,
          eventTitle: registration.event.title,
          eventDate: registration.event.start_at,
          registrationCode: registration.registration_code,
          seatCount: registration.attendee_count,
        },
        { reason: input.reason, expires_on: expiresAt },
      );
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PAYMENT_SUBMISSION_REJECTED,
      entityName: 'PaymentSubmissions',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.adminId,
      after: { reason: input.reason },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return {
      id: id.toString(),
      status: SUBMISSION_STATUS.REJECTED,
      registration_status: registration ? REGISTRATION_STATUS.PENDING_PAYMENT : null,
      expires_at: expiresAt,
    };
  });
};

/** The methods a payer may claim. Exported so the schema and the UI agree. */
export const CLAIMABLE_METHODS = [
  SUBMISSION_METHOD.NEFT,
  SUBMISSION_METHOD.UPI,
  SUBMISSION_METHOD.CHEQUE,
] as const;

/**
 * A guest submits payment for their own booking, reached by their emailed link.
 *
 * The link is the credential — resolved by the caller — so there is no user id
 * to attribute the claim to. Both actor columns stay null, which the audit row
 * records as SYSTEM; who actually paid is on the booking, not on the claim.
 */
export const submitGuestPayment = async (
  registrationId: bigint,
  input: SubmitPaymentInput,
  request: { ip: string | null; userAgent: string | null; requestId: string | null },
) =>
  submitPayment(registrationId, input, {
    userId: null,
    ip: request.ip,
    userAgent: request.userAgent,
    requestId: request.requestId,
  });

/**
 * The claims queue, for the admin screen.
 *
 * Defaults to what is actually waiting on somebody. A queue that opens showing
 * every claim ever made is a queue nobody uses, because the work is buried in
 * the history.
 */
export const listSubmissions = async (query: {
  statuses?: number[];
  methods?: number[];
  search?: string | undefined;
  page: number;
  limit: number;
}) => {
  const rows = await seats.listPaymentSubmissions(prisma, {
    ...query,
    statuses:
      query.statuses && query.statuses.length > 0 ? query.statuses : [SUBMISSION_STATUS.PENDING],
  });

  return {
    rows: rows.map(({ total: _total, ...row }) => ({
      ...row,
      id: row.id.toString(),
      invoice_id: row.invoice_id.toString(),
      amount: row.amount.toFixed(2),
    })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
};
