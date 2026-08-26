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
    include: { invoice: true },
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

    // A receipt names a member today. A guest's payment is recorded and the
    // booking confirmed; the receipt document follows when Receipts learns about
    // guests, which is a change to an M4 table and its own decision.
    const receipt = invoice.member_id
      ? await tx.receipt.create({
          data: {
            receipt_number: await nextReceiptNumber(tx, now),
            invoice_id: invoice.id,
            payment_id: payment.id,
            member_id: invoice.member_id,
            amount: invoice.total_amount,
          },
        })
      : null;

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

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.PAYMENT_VERIFIED,
      entityName: 'PaymentSubmissions',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.adminId,
      after: {
        payment_number: payment.payment_number,
        receipt_number: receipt?.receipt_number ?? null,
        invoice_number: invoice.invoice_number,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return {
      id: id.toString(),
      payment_number: payment.payment_number,
      receipt_number: receipt?.receipt_number ?? null,
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
