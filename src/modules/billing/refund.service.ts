import { Prisma } from '@prisma/client';

import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { PAYMENT_STATUS, REFUND_STATUS } from '@modules/billing/payment.constants';
import * as notify from '@modules/billing/refund.notify';
import * as repo from '@modules/billing/refund.repository';
import { AppError } from '@utils/appError';
import type { RefundRow } from '@modules/billing/refund.repository';
import type {
  CompleteRefundInput,
  ListRefundsQuery,
  RefundReasonInput,
} from '@modules/billing/refund.types';

/**
 * The refund queue, and the four decisions staff take on it.
 *
 * A refund is raised in one place only — cancelling a whole event, in
 * `registration.service.ts`. Everything here moves an existing row forward:
 *
 *     REQUESTED ──approve──► PROCESSING ──complete──► COMPLETED
 *         │                       │
 *         └──reject──► REJECTED   └──fail──► FAILED
 *
 * Amounts are never touched. The association refunds what it took, in full,
 * because a member whose event was cancelled did nothing to earn a deduction.
 * That is a business rule, not a limitation: the column would hold a smaller
 * number, and nothing here will ever write one.
 *
 * There is no approver-is-not-requester rule. Only ACCOUNTS and SUPER_ADMIN
 * hold `refund.manage`, and an ADMIN who cancels an event cannot open this
 * queue at all, so the separation is already made by the roles. Blocking a
 * super admin as well would stop honest work — they can grant themselves any
 * permission anyway — and the audit row is what actually answers "who did
 * this", in every case.
 */

export interface RefundActor {
  adminId: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/** What the queue shows for one refund. Money is a string, as everywhere else. */
export const present = (row: RefundRow) => ({
  id: row.id.toString(),
  refund_number: row.refund_number,
  amount: row.amount.toFixed(2),
  status: row.status,
  reason: row.reason,
  provider_refund_id: row.provider_refund_id,
  processed_at: row.processed_at,
  /*
    Names, not ids. `finalised_by` is whoever ended it; `status` says whether
    that was a rejection, a send, or a failure, so the screen can label the same
    person correctly without three columns that are empty in every other row.
  */
  requested_by: row.requested_by?.full_name ?? null,
  approved_by: row.approved_by?.full_name ?? null,
  finalised_by: row.finalised_by?.full_name ?? null,
  createdAt: row.createdAt,
  payment: {
    id: row.payment.id.toString(),
    amount: row.payment.amount.toFixed(2),
    invoice_number: row.payment.invoice.invoice_number,
  },
  /*
    One name, whoever the payer was. A member and a guest are different rows in
    the database and the same question on the screen — "whose money is this" —
    so the difference is resolved here rather than in every caller.
  */
  payer: {
    kind: row.payment.member ? ('MEMBER' as const) : ('GUEST' as const),
    name:
      row.payment.member?.company_name ??
      row.payment.guest_registrant?.company_name ??
      row.payment.guest_registrant?.full_name ??
      'Unknown payer',
  },
});

export const listRefunds = async (query: ListRefundsQuery) => {
  /*
    Built as a list of conditions rather than one object literal, so an unset
    filter contributes nothing at all. An empty AND matches everything, which is
    what "no opinion" has to mean here.
  */
  const conditions: Prisma.RefundWhereInput[] = [];

  if (query.status !== undefined) conditions.push({ status: query.status });

  if (query.search) {
    const term = query.search;

    conditions.push({
      OR: [
        { refund_number: { contains: term, mode: 'insensitive' } },
        { payment: { invoice: { invoice_number: { contains: term, mode: 'insensitive' } } } },
        { payment: { member: { company_name: { contains: term, mode: 'insensitive' } } } },
        { payment: { guest_registrant: { full_name: { contains: term, mode: 'insensitive' } } } },
        {
          payment: { guest_registrant: { company_name: { contains: term, mode: 'insensitive' } } },
        },
      ],
    });
  }

  const where: Prisma.RefundWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const [rows, total] = await Promise.all([
    repo.listRefunds(prisma, where, (query.page - 1) * query.limit, query.limit),
    repo.countRefunds(prisma, where),
  ]);

  return { rows: rows.map(present), total, page: query.page, limit: query.limit };
};

/**
 * Load a refund and check it is where the caller believes it is.
 *
 * The status guard is the whole safety of this module. Without it, "approve"
 * pressed twice on a stale tab approves a refund that has already been sent,
 * and the second press quietly rewrites `approved_by_admin_id` on money that
 * is already out of the account.
 */
const loadInStatus = async (id: bigint, allowed: number[]): Promise<RefundRow> => {
  const refund = await repo.findRefund(prisma, id);

  if (!refund) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'billing.refundNotFound' });
  }

  if (!allowed.includes(refund.status)) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'billing.refundWrongStatus',
    });
  }

  return refund;
};

const audit = (
  tx: Prisma.TransactionClient,
  action: string,
  refund: RefundRow,
  actor: RefundActor,
  after: Record<string, unknown>,
) =>
  writeAudit(tx, {
    action,
    entityName: 'Refunds',
    entityId: refund.id,
    actorType: ACTOR_TYPES.ADMIN,
    actorId: actor.adminId,
    before: { status: refund.status },
    after,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
  });

/** Released for sending. The money has not moved yet — `complete` says that. */
export const approveRefund = async (id: bigint, actor: RefundActor) => {
  const refund = await loadInStatus(id, [REFUND_STATUS.REQUESTED]);

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateRefund(tx, id, {
      status: REFUND_STATUS.PROCESSING,
      // Relation syntax now that the actor columns are real foreign keys: an
      // id with no account behind it would render as a name nobody can explain.
      approved_by: { connect: { id: actor.adminId } },
      updated_by_admin_id: actor.adminId,
    });

    await notify.notifyRefundApproved(tx, refund);

    await audit(tx, AUDIT_ACTIONS.REFUND_APPROVED, refund, actor, {
      status: REFUND_STATUS.PROCESSING,
      approved_by_admin_id: actor.adminId.toString(),
    });

    return { id: updated.id.toString(), status: updated.status };
  });
};

/**
 * Refused, with a reason the payer is given.
 *
 * The payment goes back to SUCCESS. Cancelling the event marked it REFUNDED in
 * anticipation, and leaving it there would say money was returned that never
 * was — the ledger would disagree with the bank for the rest of its life.
 */
export const rejectRefund = async (id: bigint, input: RefundReasonInput, actor: RefundActor) => {
  const refund = await loadInStatus(id, [REFUND_STATUS.REQUESTED]);

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateRefund(tx, id, {
      status: REFUND_STATUS.REJECTED,
      reason: input.reason,
      finalised_by: { connect: { id: actor.adminId } },
      updated_by_admin_id: actor.adminId,
    });

    await tx.payment.update({
      where: { id: refund.payment.id },
      data: { status: PAYMENT_STATUS.SUCCESS, updated_by_admin_id: actor.adminId },
    });

    await notify.notifyRefundRejected(tx, refund, input.reason);

    await audit(tx, AUDIT_ACTIONS.REFUND_REJECTED, refund, actor, {
      status: REFUND_STATUS.REJECTED,
      reason: input.reason,
    });

    return { id: updated.id.toString(), status: updated.status };
  });
};

/** The money has actually gone back, and here is the bank's reference for it. */
export const completeRefund = async (
  id: bigint,
  input: CompleteRefundInput,
  actor: RefundActor,
  now = new Date(),
) => {
  const refund = await loadInStatus(id, [REFUND_STATUS.PROCESSING]);

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateRefund(tx, id, {
      status: REFUND_STATUS.COMPLETED,
      provider_refund_id: input.reference,
      processed_at: now,
      finalised_by: { connect: { id: actor.adminId } },
      updated_by_admin_id: actor.adminId,
    });

    await notify.notifyRefundCompleted(tx, refund, input.reference);

    await audit(tx, AUDIT_ACTIONS.REFUND_COMPLETED, refund, actor, {
      status: REFUND_STATUS.COMPLETED,
      provider_refund_id: input.reference,
    });

    return { id: updated.id.toString(), status: updated.status };
  });
};

/**
 * The transfer bounced.
 *
 * Failed, not back to REQUESTED: the approval genuinely happened and should not
 * be erased by a bank rejecting an account number. The queue shows FAILED so
 * somebody picks it up, rather than it looking untouched.
 */
export const failRefund = async (id: bigint, input: RefundReasonInput, actor: RefundActor) => {
  const refund = await loadInStatus(id, [REFUND_STATUS.PROCESSING]);

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateRefund(tx, id, {
      status: REFUND_STATUS.FAILED,
      reason: input.reason,
      finalised_by: { connect: { id: actor.adminId } },
      updated_by_admin_id: actor.adminId,
    });

    await audit(tx, AUDIT_ACTIONS.REFUND_FAILED, refund, actor, {
      status: REFUND_STATUS.FAILED,
      reason: input.reason,
    });

    return { id: updated.id.toString(), status: updated.status };
  });
};
