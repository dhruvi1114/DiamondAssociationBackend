import { InvoiceStatus, TermStatus, TermType } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma, type Db } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { getNumericSetting, getSetting, SETTING_KEYS, type RenewalBasis } from '@helpers/settings';
import { SUBMISSION_STATUS } from '@modules/event/registration.constants';
import { CYCLE_MONTHS, listPublicPlans } from '@modules/masters/masters.feePlans.service';
import { addDays, daysBetween, dbToday, isoDay } from '@modules/renewal/renewal.dates';
import { loadLivePlan } from '@modules/renewal/renewal.pricing';
import { raiseRenewal } from '@modules/renewal/renewal.raise';
import { termState } from '@modules/renewal/renewal.state';
import { AppError } from '@utils/appError';

/**
 * The member's own term (C-18) and the plan-switch action on it (C-23).
 *
 * The member's term view, history, plan list and plan-switch — the customer portal's banner and
 * "My membership" page (Tasks 13-14) consume this frozen contract, so its four return shapes are
 * not to be reshaped without also updating those tasks.
 */

const WAITING = [TermStatus.PENDING_PAYMENT, TermStatus.PAID_UPCOMING];
const SWITCHABLE_INVOICE: InvoiceStatus[] = [InvoiceStatus.ISSUED, InvoiceStatus.OVERDUE];
const OPEN_TERM: TermStatus[] = [TermStatus.ACTIVE, TermStatus.EXPIRED];

const notFound = (messageKey: string) =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey });
const conflict = (messageKey: string) =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey });

type AuditActor = {
  actorId: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
};

/** The renewal waiting behind the current term, with its invoice and any claim being checked. */
const nextTerm = (db: Db, memberId: bigint, after: Date) =>
  db.membershipTerm.findFirst({
    where: {
      member_id: memberId,
      term_type: TermType.RENEWAL,
      status: { in: WAITING },
      valid_from: { gt: after },
    },
    orderBy: { valid_from: 'asc' },
    include: {
      fee_plan: { select: { name: true } },
      invoice: {
        include: {
          paymentSubmissions: {
            where: { status: SUBMISSION_STATUS.PENDING },
            select: { id: true },
          },
        },
      },
    },
  });

/**
 * Cancel a raised-but-unpaid renewal term and its invoice, with the audit row that records why.
 * Shared by `switchRenewalPlan` (cancels the old invoice before raising a new one on the chosen
 * plan) and `declineRenewal` (cancels any invoice already raised) — the three-statement sequence
 * — cancel invoice, cancel term, write an INVOICE_CANCELLED audit row — was otherwise duplicated
 * verbatim, differing only in the audit reason string.
 */
const cancelPendingRenewal = async (
  tx: Db,
  termId: bigint,
  invoice: { id: bigint; status: InvoiceStatus },
  audit: AuditActor,
  reason: string,
) => {
  await tx.invoice.update({
    where: { id: invoice.id },
    data: { status: InvoiceStatus.CANCELLED },
  });
  await tx.membershipTerm.update({
    where: { id: termId },
    data: { status: TermStatus.CANCELLED },
  });
  await writeAudit(tx, {
    actorType: ACTOR_TYPES.MEMBER,
    ...audit,
    action: AUDIT_ACTIONS.INVOICE_CANCELLED,
    entityName: 'Invoices',
    entityId: invoice.id,
    before: { status: invoice.status },
    after: { status: InvoiceStatus.CANCELLED, reason },
  });
};

/** `GET /membership/me/term` — the banner and the "My membership" page's headline card. */
export const getMyTermView = async (memberId: bigint, now: Date = new Date()) => {
  const today = dbToday(now);
  const noticeDays = await getNumericSetting(SETTING_KEYS.RENEWAL_NOTICE_DAYS, 15);
  const graceDays = await getNumericSetting(SETTING_KEYS.MEMBERSHIP_GRACE_DAYS, 30);

  const member = await prisma.member.findFirst({
    where: { id: memberId, deletedAt: null },
    select: {
      status: true,
      current_term: {
        select: {
          id: true,
          term_type: true,
          status: true,
          valid_from: true,
          valid_till: true,
          renewal_declined_at: true,
          fee_plan: {
            select: {
              id: true,
              name: true,
              billing_cycle: true,
              renewal_amount: true,
              tax_rate: true,
              currency: true,
            },
          },
        },
      },
    },
  });
  if (!member) throw notFound('member.notFound');

  const current = member.current_term;
  const next = current ? await nextTerm(prisma, memberId, current.valid_till) : null;
  const invoice = next?.invoice ?? null;
  const pendingClaim = Boolean(invoice && invoice.paymentSubmissions.length > 0);

  return {
    state: termState({
      memberStatus: member.status,
      current: current ? { status: current.status, valid_till: current.valid_till } : null,
      renewalStatus: next?.status ?? null,
      today,
      noticeDays,
      declined: Boolean(current?.renewal_declined_at),
    }),
    member_status: member.status,
    today: isoDay(today),
    days_left: current ? daysBetween(today, current.valid_till) : null,
    grace_ends_on: current ? isoDay(addDays(current.valid_till, graceDays)) : null,
    notice_days: noticeDays,
    current_term: current && {
      id: current.id.toString(),
      term_type: current.term_type,
      status: current.status,
      valid_from: isoDay(current.valid_from),
      valid_till: isoDay(current.valid_till),
      plan: current.fee_plan && {
        id: current.fee_plan.id.toString(),
        name: current.fee_plan.name,
        billing_cycle: current.fee_plan.billing_cycle,
        renewal_amount: current.fee_plan.renewal_amount.toFixed(2),
        tax_rate: current.fee_plan.tax_rate.toFixed(2),
        currency: current.fee_plan.currency,
      },
    },
    renewal: next && {
      term_id: next.id.toString(),
      status: next.status,
      valid_from: isoDay(next.valid_from),
      valid_till: isoDay(next.valid_till),
      plan_name: next.fee_plan?.name ?? null,
      invoice: invoice && {
        id: invoice.id.toString(),
        invoice_number: invoice.invoice_number,
        total_amount: invoice.total_amount.toFixed(2),
        currency: invoice.currency,
        due_date: isoDay(invoice.due_date),
        status: invoice.status,
        pending_claim: pendingClaim,
      },
    },
    can_change_plan:
      next?.status === TermStatus.PENDING_PAYMENT &&
      invoice !== null &&
      SWITCHABLE_INVOICE.includes(invoice.status) &&
      !pendingClaim,
    renewal_declined: Boolean(current?.renewal_declined_at),
    can_decline:
      member.status === 'ACTIVE' &&
      !!current &&
      OPEN_TERM.includes(current.status) &&
      !current.renewal_declined_at &&
      (!next ||
        (next.status === TermStatus.PENDING_PAYMENT &&
          invoice !== null &&
          SWITCHABLE_INVOICE.includes(invoice.status) &&
          !pendingClaim)),
    can_resume:
      Boolean(current?.renewal_declined_at) && ['ACTIVE', 'EXPIRED'].includes(member.status),
  };
};

/** `GET /membership/me/terms` — newest first, max 50, CANCELLED excluded. */
export const listMyTerms = async (memberId: bigint) => {
  const rows = await prisma.membershipTerm.findMany({
    where: { member_id: memberId, status: { not: TermStatus.CANCELLED } },
    orderBy: { valid_from: 'desc' },
    take: 50,
    include: {
      fee_plan: { select: { name: true } },
      invoice: { select: { id: true, invoice_number: true, total_amount: true } },
    },
  });
  return rows.map((t) => ({
    id: t.id.toString(),
    term_type: t.term_type,
    status: t.status,
    valid_from: isoDay(t.valid_from),
    valid_till: isoDay(t.valid_till),
    plan_name: t.fee_plan?.name ?? null,
    // The id too, so the member's timeline can download the invoice PDF.
    invoice_id: t.invoice?.id.toString() ?? null,
    invoice_number: t.invoice?.invoice_number ?? null,
    total_amount: t.invoice?.total_amount.toFixed(2) ?? null,
  }));
};

/** `GET /membership/me/renewal/plans` — plans live today, for the plan-switch picker. */
export const listMyRenewalPlans = async (memberId: bigint) => {
  const member = await prisma.member.findFirst({
    where: { id: memberId },
    select: { current_term: { select: { valid_till: true, fee_plan_id: true } } },
  });
  const next = member?.current_term
    ? await nextTerm(prisma, memberId, member.current_term.valid_till)
    : null;
  const currentPlanId = next?.fee_plan_id ?? member?.current_term?.fee_plan_id ?? null;

  const plans = await listPublicPlans();
  return plans.map((p) => {
    const tax = p.renewal_amount.mul(p.tax_rate).div(100).toDecimalPlaces(2);
    return {
      id: p.id.toString(),
      name: p.name,
      billing_cycle: p.billing_cycle,
      duration_months: CYCLE_MONTHS[p.billing_cycle],
      renewal_amount: p.renewal_amount.toFixed(2),
      tax_rate: p.tax_rate.toFixed(2),
      renewal_total: p.renewal_amount.add(tax).toFixed(2),
      currency: p.currency,
      is_current: currentPlanId !== null && p.id === currentPlanId,
    };
  });
};

/** C-23: switch plan while the renewal invoice is unpaid (decided 2026-09-10). */
export const switchRenewalPlan = async (
  memberId: bigint,
  feePlanId: bigint,
  audit: { actorId: bigint; ip: string | null; userAgent: string | null; requestId: string | null },
) => {
  const today = dbToday();
  const basis = ((await getSetting(SETTING_KEYS.RENEWAL_BASIS)) ?? 'term') as RenewalBasis;
  const dueDays = await getNumericSetting(SETTING_KEYS.INVOICE_DUE_DAYS, 15);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('membership.renewal'), (${memberId} % 2147483647)::int)`;

    const member = await tx.member.findFirst({
      where: { id: memberId },
      select: { current_term: { select: { valid_till: true, category_id: true, tier_id: true } } },
    });
    const current = member?.current_term;
    if (!current) throw notFound('renewal.noPendingRenewal');

    const next = await nextTerm(tx, memberId, current.valid_till);
    if (!next || next.status !== TermStatus.PENDING_PAYMENT || !next.invoice) {
      throw notFound('renewal.noPendingRenewal');
    }
    if (
      !SWITCHABLE_INVOICE.includes(next.invoice.status) ||
      next.invoice.paymentSubmissions.length > 0
    ) {
      throw conflict('renewal.claimPending');
    }

    const plan = await loadLivePlan(tx, feePlanId, today);
    if (!plan) throw conflict('renewal.planNotAvailable');
    if (plan.id === next.fee_plan_id) throw conflict('renewal.samePlan');

    // Cancel first: the partial unique index ignores CANCELLED, so the new term can take the
    // same start date in the same transaction.
    await cancelPendingRenewal(tx, next.id, next.invoice, audit, 'Plan switched at renewal');

    const result = await raiseRenewal(
      tx,
      {
        memberId,
        categoryId: current.category_id,
        tierId: current.tier_id,
        feePlanId: null,
        previousValidTill: addDays(next.valid_from, -1),
      },
      { today, basis, dueDays, planOverride: plan },
    );
    if (result.outcome !== 'RAISED') throw conflict('renewal.planNotAvailable');
  });

  return getMyTermView(memberId);
};

/** "I don't want to renew" (decided 2026-09-10). Access continues to the end of the term, then grace. */
export const declineRenewal = async (memberId: bigint, audit: AuditActor) => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('membership.renewal'), (${memberId} % 2147483647)::int)`;

    const member = await tx.member.findFirst({
      where: { id: memberId },
      select: {
        status: true,
        current_term: {
          select: { id: true, status: true, valid_till: true, renewal_declined_at: true },
        },
      },
    });
    const current = member?.current_term;
    if (!member || member.status !== 'ACTIVE' || !current || !OPEN_TERM.includes(current.status)) {
      throw conflict('renewal.cannotDecline');
    }
    if (current.renewal_declined_at) return; // already declined — pressing twice is not an error

    const next = await nextTerm(tx, memberId, current.valid_till);
    if (next) {
      const invoice = next.invoice;
      if (
        next.status !== TermStatus.PENDING_PAYMENT ||
        !invoice ||
        !SWITCHABLE_INVOICE.includes(invoice.status) ||
        invoice.paymentSubmissions.length > 0
      ) {
        throw conflict('renewal.cannotDecline');
      }
      await cancelPendingRenewal(tx, next.id, invoice, audit, 'Member declined renewal');
    }

    const at = new Date();
    await tx.membershipTerm.update({
      where: { id: current.id },
      data: { renewal_declined_at: at },
    });
    await writeAudit(tx, {
      actorType: ACTOR_TYPES.MEMBER,
      ...audit,
      action: AUDIT_ACTIONS.RENEWAL_DECLINED,
      entityName: 'MembershipTerms',
      entityId: current.id,
      before: { renewal_declined_at: null },
      after: { renewal_declined_at: at.toISOString() },
    });
  });

  return getMyTermView(memberId);
};

/** "Renew after all": undo the decision; bill now if the term ends inside the window or has ended. */
export const resumeRenewal = async (memberId: bigint, audit: AuditActor) => {
  const today = dbToday();
  const basis = ((await getSetting(SETTING_KEYS.RENEWAL_BASIS)) ?? 'term') as RenewalBasis;
  const noticeDays = await getNumericSetting(SETTING_KEYS.RENEWAL_NOTICE_DAYS, 15);
  const dueDays = await getNumericSetting(SETTING_KEYS.INVOICE_DUE_DAYS, 15);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('membership.renewal'), (${memberId} % 2147483647)::int)`;

    const member = await tx.member.findFirst({
      where: { id: memberId },
      select: {
        status: true,
        current_term: {
          select: {
            id: true,
            valid_till: true,
            category_id: true,
            tier_id: true,
            fee_plan_id: true,
            renewal_declined_at: true,
          },
        },
      },
    });
    const current = member?.current_term;
    if (
      !member ||
      !current?.renewal_declined_at ||
      !['ACTIVE', 'EXPIRED'].includes(member.status)
    ) {
      throw conflict('renewal.notDeclined');
    }

    await tx.membershipTerm.update({
      where: { id: current.id },
      data: { renewal_declined_at: null },
    });
    await writeAudit(tx, {
      actorType: ACTOR_TYPES.MEMBER,
      ...audit,
      action: AUDIT_ACTIONS.RENEWAL_RESUMED,
      entityName: 'MembershipTerms',
      entityId: current.id,
      before: { renewal_declined_at: current.renewal_declined_at.toISOString() },
      after: { renewal_declined_at: null },
    });

    if (current.valid_till <= addDays(today, noticeDays)) {
      const result = await raiseRenewal(
        tx,
        {
          memberId,
          categoryId: current.category_id,
          tierId: current.tier_id,
          feePlanId: current.fee_plan_id,
          previousValidTill: current.valid_till,
        },
        { today, basis, dueDays },
      );
      if (result.outcome === 'SKIPPED' && result.reason !== 'ALREADY_RAISED')
        throw conflict('renewal.planNotAvailable');
    }
  });

  return getMyTermView(memberId);
};
