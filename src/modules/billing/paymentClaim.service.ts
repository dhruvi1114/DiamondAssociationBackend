import { InvoiceStatus, Prisma } from '@prisma/client';

import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { SUBMISSION_STATUS } from '@modules/event/registration.constants';
import { notifyClaimReceived } from '@modules/billing/membershipNotify';
import { removeProof, storeProof, type UploadedFile } from '@modules/billing/paymentProof.service';
import { AppError } from '@utils/appError';

/**
 * "I have paid this invoice" — for an invoice with no booking behind it.
 *
 * Membership and renewal invoices go through here. The event claim
 * (`event/payment.service.ts`) does the same thing plus the seat bookkeeping a
 * booking needs: stopping the hold clock, moving the registration to
 * PAYMENT_UNDER_VERIFICATION. An invoice on its own has neither, so a second
 * entry point is honest — the two write the same `PaymentSubmission` row and
 * land in the same queue, and **the same admin `verifyPayment` settles both**.
 *
 * The member does NOT become active here. Filing a claim is an assertion; the
 * membership switches on when a person has checked it against the bank.
 */

const conflict = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey });

const notFound = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey });

export interface InvoiceClaimInput {
  method: number;
  reference_no: string;
  amount: number;
  paid_on: Date;
}

/** Statuses that still owe money. DRAFT is not payable; PAID and CANCELLED are done. */
const CLAIMABLE: InvoiceStatus[] = [
  InvoiceStatus.ISSUED,
  InvoiceStatus.PARTIALLY_PAID,
  InvoiceStatus.OVERDUE,
];

const loadClaimableInvoice = async (memberId: bigint, invoiceId: bigint) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, member_id: memberId, deletedAt: null },
  });

  if (!invoice) throw notFound('member.invoiceNotFound');
  if (invoice.status === InvoiceStatus.PAID) throw conflict('member.invoiceAlreadyPaid');
  if (!CLAIMABLE.includes(invoice.status)) throw conflict('member.invoiceNotPayable');

  /*
    One live claim per invoice. Without this a member who is unsure whether the
    first went through files a second, and the queue shows one invoice twice —
    which is how the same money gets verified twice.
  */
  const pending = await prisma.paymentSubmission.count({
    where: { invoice_id: invoiceId, status: SUBMISSION_STATUS.PENDING },
  });

  if (pending > 0) throw conflict('billing.claimAlreadyPending');

  return invoice;
};

export const submitInvoiceClaim = async (
  memberId: bigint,
  invoiceId: bigint,
  input: InvoiceClaimInput,
  proof: UploadedFile,
  actor: { userId: bigint | null },
) => {
  const invoice = await loadClaimableInvoice(memberId, invoiceId);

  /*
    Stored before the write, and cleaned up if the write fails — the same order
    the event claim uses, and for the same reason: holding a transaction open
    across a multi-megabyte upload puts a row lock behind an I/O call.
  */
  const stored = await storeProof(invoice.id, proof);

  try {
    return await prisma.$transaction(async (tx) => {
      const submission = await tx.paymentSubmission.create({
        data: {
          invoice_id: invoice.id,
          submitted_by_user_id: actor.userId,
          method: input.method,
          reference_no: input.reference_no,
          amount: new Prisma.Decimal(input.amount),
          paid_on: input.paid_on,
          proof_path: stored.key,
          status: SUBMISSION_STATUS.PENDING,
          created_by_user_id: actor.userId,
        },
        select: { id: true, reference_no: true, status: true },
      });

      /*
        Queued inside the transaction (ADR-010). "We have your payment details"
        for a claim that then rolled back tells a member to stop worrying about
        an invoice still sitting unpaid on their screen.

        The acknowledgement matters more here than it does for a booking: a
        booking visibly moves to "being verified", where a membership invoice
        does not change at all until somebody decides.
      */
      const member = await tx.member.findFirst({
        where: { id: memberId },
        select: {
          id: true,
          company_name: true,
          contacts: {
            where: { is_primary: true, deletedAt: null },
            take: 1,
            select: { email: true },
          },
        },
      });

      if (member) {
        await notifyClaimReceived(
          tx,
          {
            memberId: member.id,
            toAddress: member.contacts[0]?.email ?? null,
            companyName: member.company_name,
            invoiceNumber: invoice.invoice_number,
            amount: invoice.total_amount.toFixed(2),
          },
          submission.reference_no,
        );
      }

      return submission;
    });
  } catch (error) {
    await removeProof(stored.key);

    throw error;
  }
};
