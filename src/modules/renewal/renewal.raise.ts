import { InvoiceStatus, InvoiceType, Prisma, TermStatus, TermType } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { writeAudit } from '@helpers/audit';
import { allocateInvoiceNumber } from '@helpers/documentNumber';
import type { RenewalBasis } from '@helpers/settings';
import { addDays, isoDay, planRenewalTerm } from '@modules/renewal/renewal.dates';
import {
  durationOf,
  loadRenewalPlan,
  priceRenewal,
  type RenewalPlan,
} from '@modules/renewal/renewal.pricing';

export interface RenewalSource {
  memberId: bigint;
  categoryId: bigint;
  tierId: bigint | null;
  feePlanId: bigint | null;
  previousValidTill: Date;
}

export interface RaiseOptions {
  today: Date;
  basis: RenewalBasis;
  dueDays: number;
  planOverride?: RenewalPlan;
}

export type RaiseResult =
  | { outcome: 'RAISED'; termId: bigint; invoiceId: bigint; invoiceNumber: string; total: string }
  | { outcome: 'SKIPPED'; reason: 'ALREADY_RAISED' | 'NO_PLAN' | 'NO_PRICE' };

/**
 * Raise one member's next term and the invoice that pays for it.
 *
 * Runs in the caller's transaction: the term and its invoice are one fact, and a crash between
 * them would leave a member billed for nothing or covered for free.
 */
export const raiseRenewal = async (
  tx: Prisma.TransactionClient,
  src: RenewalSource,
  opts: RaiseOptions,
): Promise<RaiseResult> => {
  // Before any invoice number is taken: a number allocated in a transaction that then rolls back
  // is a gap in the invoice series. The unique index is the backstop, this is the courtesy.
  // $executeRaw, not $queryRaw: the function returns void, which Prisma cannot deserialise.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('membership.renewal'), (${src.memberId} % 2147483647)::int)`;

  const validFrom = addDays(src.previousValidTill, 1);

  const existing = await tx.membershipTerm.findFirst({
    where: {
      member_id: src.memberId,
      valid_from: validFrom,
      status: { not: TermStatus.CANCELLED },
    },
    select: { id: true },
  });
  if (existing) return { outcome: 'SKIPPED', reason: 'ALREADY_RAISED' };

  const plan =
    opts.planOverride ??
    (src.feePlanId ? await loadRenewalPlan(tx, src.feePlanId, validFrom) : null);
  if (!plan) return { outcome: 'SKIPPED', reason: 'NO_PLAN' };
  // A ₹0 invoice raised because nobody priced renewal is far worse than a job that refused.
  if (plan.renewal_amount.lte(0)) return { outcome: 'SKIPPED', reason: 'NO_PRICE' };

  const window = planRenewalTerm({
    from: validFrom,
    durationMonths: durationOf(plan),
    basis: opts.basis,
  });
  const price = priceRenewal(plan.renewal_amount, plan.tax_rate, window);

  const term = await tx.membershipTerm.create({
    data: {
      member_id: src.memberId,
      category_id: src.categoryId,
      tier_id: src.tierId,
      term_type: TermType.RENEWAL,
      valid_from: window.validFrom,
      valid_till: window.validTill,
      status: TermStatus.PENDING_PAYMENT,
      fee_plan_id: plan.id,
    },
  });

  const dueDate = addDays(opts.today, Math.max(opts.dueDays, 0));
  const months = `${window.months} month${window.months === 1 ? '' : 's'}`;
  const period = window.prorated ? `${months}, pro-rata to ${isoDay(window.validTill)}` : months;

  const invoice = await tx.invoice.create({
    data: {
      invoice_number: await allocateInvoiceNumber(tx, opts.today),
      member_id: src.memberId,
      invoice_type: InvoiceType.RENEWAL,
      status: InvoiceStatus.ISSUED,
      issue_date: opts.today,
      due_date: dueDate,
      subtotal: price.net,
      tax_amount: price.tax,
      total_amount: price.total,
      amount_paid: new Prisma.Decimal(0),
      balance_due: price.total,
      currency: plan.currency,
      items: {
        create: [
          {
            description: `${plan.name} renewal (${period})`,
            quantity: new Prisma.Decimal(1),
            unit_price: price.net,
            tax_rate: plan.tax_rate,
            tax_amount: price.tax,
            line_total: price.total,
            fee_structure_id: null,
            fee_plan_id: plan.id,
            sort_order: 0,
          },
        ],
      },
    },
  });

  await tx.membershipTerm.update({ where: { id: term.id }, data: { invoice_id: invoice.id } });

  // Copy the SYSTEM-actor shape from event/expiry.service.ts verbatim for the remaining fields.
  const system = {
    actorType: ACTOR_TYPES.SYSTEM,
    actorId: null,
    ip: null,
    userAgent: null,
    requestId: null,
  };
  await writeAudit(tx, {
    ...system,
    action: AUDIT_ACTIONS.TERM_CREATED,
    entityName: 'MembershipTerms',
    entityId: term.id,
    before: null,
    after: {
      term_type: 'RENEWAL',
      valid_from: isoDay(window.validFrom),
      valid_till: isoDay(window.validTill),
    },
  });
  await writeAudit(tx, {
    ...system,
    action: AUDIT_ACTIONS.INVOICE_ISSUED,
    entityName: 'Invoices',
    entityId: invoice.id,
    before: null,
    after: { invoice_type: 'RENEWAL', total_amount: price.total.toFixed(2) },
  });

  return {
    outcome: 'RAISED',
    termId: term.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    total: price.total.toFixed(2),
  };
};
