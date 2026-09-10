import { InvoiceStatus, Prisma } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
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
import {
  proofMimeForKey,
  removeProof,
  storeProof,
  type UploadedFile,
} from '@modules/billing/paymentProof.service';
import { getStorage } from '@helpers/storage';
import { activateMembershipForInvoice } from '@modules/billing/membershipActivation';
import * as membershipNotify from '@modules/billing/membershipNotify';
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
}

/**
 * "I have paid."
 *
 * The hold clock **stops** here by clearing `expires_at`: the payer has done
 * their part, and letting the sweep release their seats while staff work through
 * the queue would punish them for the association's response time.
 *
 * The receipt is required, not optional. A claim is an assertion until somebody
 * checks it, and a reference number alone sends the checker to their bank portal
 * for every single claim; the attachment is what makes the queue workable.
 */
export const submitPayment = async (
  registrationId: bigint,
  input: SubmitPaymentInput,
  proof: UploadedFile,
  actor: {
    userId: bigint | null;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  },
) => {
  const registration = await loadClaimableRegistration(registrationId);

  /*
    Stored BEFORE the transaction, deliberately. Writing several megabytes
    through the storage adapter is slow and can reach the network, and holding a
    database transaction open across it puts a row lock behind an I/O call.

    The cost is that a failed transaction leaves an orphaned file, which the
    catch below clears on a best effort. That is the right way round: a wasted
    object costs disk, where a claim lost to a storage hiccup costs somebody
    their seats.
  */
  const stored = await storeProof(registration.invoice.id, proof);

  try {
    return await claimPayment(registrationId, registration, input, stored.key, actor);
  } catch (error) {
    await removeProof(stored.key);

    throw error;
  }
};

/**
 * The booking a claim is being made against, or the reason it cannot be.
 *
 * Its own function so the claim below can be typed from it — and so the three
 * refusals are read in one place rather than at the top of a long procedure.
 */
const loadClaimableRegistration = async (registrationId: bigint) => {
  const registration = await prisma.eventRegistration.findFirst({
    where: { id: registrationId, deletedAt: null },
    include: { invoice: true, event: { select: { title: true, start_at: true } } },
  });

  if (!registration) throw notFound('event.registrationNotFound');
  if (registration.status !== REGISTRATION_STATUS.PENDING_PAYMENT) {
    throw conflict('event.notAwaitingPayment');
  }
  if (!registration.invoice) throw conflict('event.noInvoiceToPay');

  /* Re-spread so `invoice` is non-null in the RETURN type, not merely narrowed
     inside this function — the caller stores the proof against its id. */
  return { ...registration, invoice: registration.invoice };
};

/** The write itself, once the receipt is safely stored. */
const claimPayment = async (
  registrationId: bigint,
  registration: Awaited<ReturnType<typeof loadClaimableRegistration>>,
  input: SubmitPaymentInput,
  proofPath: string,
  actor: {
    userId: bigint | null;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  },
) => {
  return prisma.$transaction(async (tx) => {
    const submission = await tx.paymentSubmission.create({
      data: {
        invoice_id: registration.invoice.id,
        submitted_by_user_id: actor.userId,
        method: input.method,
        reference_no: input.reference_no,
        amount: new Prisma.Decimal(input.amount),
        paid_on: input.paid_on,
        proof_path: proofPath,
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

    /*
      A membership invoice has no event behind it, and settling one has to do
      more than mark it paid: the terms it bought go live and a first-time member
      moves PENDING → ACTIVE. Without this, a member filed a claim, an admin
      approved it, the invoice read PAID — and their membership sat pending with
      nothing left to move it.

      Guarded on `member_id` rather than on invoice type: a guest's event invoice
      has no member to activate, and a member's event invoice has no membership
      term pointing at it, so the call is a no-op there either way.
    */
    if (invoice.member_id) {
      await activateMembershipForInvoice(tx, {
        invoiceId: invoice.id,
        memberId: invoice.member_id,
        invoiceNumber: invoice.invoice_number,
        changedByAdminId: actor.adminId,
      });

      const notice = await membershipNotice(tx, invoice);

      if (notice) await membershipNotify.notifyClaimVerified(tx, notice);
    }

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
 * Who to write to about a membership payment, or null when it is not one.
 *
 * Null for an event invoice and for a guest: those are told through the booking
 * notifications, which say something this one cannot — what happened to the
 * seats. A membership invoice has no booking, so without this a member heard
 * nothing at all either way.
 */
const membershipNotice = async (
  db: Db,
  invoice: {
    id: bigint;
    member_id: bigint | null;
    invoice_number: string;
    total_amount: Prisma.Decimal;
  },
) => {
  if (!invoice.member_id) return null;

  const hasBooking = await db.eventRegistration.count({
    where: { invoice_id: invoice.id, deletedAt: null },
  });

  if (hasBooking > 0) return null;

  const member = await db.member.findFirst({
    where: { id: invoice.member_id },
    select: {
      id: true,
      company_name: true,
      /* The primary contact — every company has one, and it is the address the
         association already writes to about money. */
      contacts: {
        where: { is_primary: true, deletedAt: null },
        take: 1,
        select: { email: true },
      },
    },
  });

  if (!member) return null;

  return {
    memberId: member.id,
    toAddress: member.contacts[0]?.email ?? null,
    companyName: member.company_name,
    invoiceNumber: invoice.invoice_number,
    amount: invoice.total_amount.toFixed(2),
  };
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

    /*
      A membership claim has no booking, so the branch above sends nothing. The
      member would otherwise learn that their payment was not traced by noticing,
      days later, that they are still not active — the invoice is untouched and
      the screen looks exactly as it did before they claimed.
    */
    const notice = await membershipNotice(tx, submission.invoice);

    if (notice) await membershipNotify.notifyClaimRejected(tx, notice, input.reason);

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
  proof: UploadedFile,
  request: { ip: string | null; userAgent: string | null; requestId: string | null },
) =>
  submitPayment(registrationId, input, proof, {
    userId: null,
    ip: request.ip,
    userAgent: request.userAgent,
    requestId: request.requestId,
  });

/**
 * Open a claim's receipt for whoever is entitled to see it.
 *
 * Staff, because verifying is the whole point of the file; and the company that
 * filed the claim, so a member can check they attached the right screenshot.
 * Anyone else gets **404, never 403** — the same rule the document downloads
 * follow, because a 403 confirms the id exists and turns this into an oracle
 * for counting the association's payments.
 *
 * Scoped to the company rather than the login: the colleague who paid and the
 * colleague who checks are often different people at the same firm, which is how
 * every other member-facing read on this platform is scoped.
 */
export const openProofForDownload = async (
  submissionId: bigint,
  viewer: { userId: bigint | null; isAdmin: boolean },
) => {
  const submission = await prisma.paymentSubmission.findFirst({
    where: { id: submissionId },
    select: { proof_path: true, reference_no: true, invoice: { select: { member_id: true } } },
  });

  if (!submission?.proof_path) throw notFound('billing.proofNotFound');

  if (!viewer.isAdmin) {
    const memberId = submission.invoice?.member_id ?? null;

    const allowed =
      memberId !== null &&
      viewer.userId !== null &&
      (await prisma.member.count({
        where: {
          id: memberId,
          deletedAt: null,
          team_users: { some: { user_id: viewer.userId, status: 1 } },
        },
      })) > 0;

    if (!allowed) throw notFound('billing.proofNotFound');
  }

  const mime = proofMimeForKey(submission.proof_path);
  const extension = submission.proof_path.slice(submission.proof_path.lastIndexOf('.'));

  return {
    stream: await getStorage().getStream(submission.proof_path),
    /* Named after the claim, not after whatever the payer called the file on
       their phone — the original name is not stored, and "IMG_4821.jpg" in a
       verifier's downloads folder belongs to nothing. */
    filename: `payment-proof-${submission.reference_no.replace(/[^A-Za-z0-9._-]/g, '')}${extension}`,
    mime,
  };
};

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
