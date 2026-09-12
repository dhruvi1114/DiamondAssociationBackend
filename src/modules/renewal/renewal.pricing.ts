import { Prisma, type BillingCycle, type PriceScope } from '@prisma/client';
import type { Db } from '@db/prisma';
import type { TermWindow } from '@helpers/membershipTerm';
import { CYCLE_MONTHS } from '@modules/masters/masters.feePlans.service';

/**
 * What a renewal costs.
 *
 * The member's own plan prices their renewal (`MembershipTerms.fee_plan_id`). When that plan has
 * been closed and replaced, `price_scope` on the replacement decides: ALL_MEMBERS moves them to
 * it, NEW_MEMBERS_ONLY leaves them on the closed plan's renewal price (fee-plans spec §7).
 */

export interface RenewalPlan {
  id: bigint;
  billing_cycle: BillingCycle;
  name: string;
  renewal_amount: Prisma.Decimal;
  tax_rate: Prisma.Decimal;
  currency: string;
  effective_from: Date;
  effective_to: Date | null;
  is_active: boolean;
  price_scope: PriceScope;
}

const PLAN_SELECT = {
  id: true,
  billing_cycle: true,
  name: true,
  renewal_amount: true,
  tax_rate: true,
  currency: true,
  effective_from: true,
  effective_to: true,
  is_active: true,
  price_scope: true,
} as const;

export const isLiveOn = (plan: RenewalPlan, day: Date): boolean =>
  plan.is_active &&
  plan.effective_from <= day &&
  (plan.effective_to === null || plan.effective_to >= day);

export const pickRenewalPlan = (
  own: RenewalPlan,
  liveSameCycle: RenewalPlan | null,
  day: Date,
): RenewalPlan => {
  if (isLiveOn(own, day)) return own;
  if (liveSameCycle && liveSameCycle.id !== own.id && liveSameCycle.price_scope === 'ALL_MEMBERS') {
    return liveSameCycle;
  }
  return own;
};

/** The same "live on a date" predicate the public plans page uses (`listPublicPlans`). */
const liveWhere = (day: Date) => ({
  deletedAt: null,
  is_active: true,
  structure: { is_active: true, deletedAt: null },
  effective_from: { lte: day },
  OR: [{ effective_to: null }, { effective_to: { gte: day } }],
});

export const loadRenewalPlan = async (
  db: Db,
  feePlanId: bigint,
  day: Date,
): Promise<RenewalPlan | null> => {
  const own = await db.feePlan.findFirst({
    where: { id: feePlanId, deletedAt: null },
    select: PLAN_SELECT,
  });
  if (!own) return null;

  const live = await db.feePlan.findFirst({
    where: { ...liveWhere(day), billing_cycle: own.billing_cycle },
    orderBy: { effective_from: 'desc' },
    select: PLAN_SELECT,
  });

  return pickRenewalPlan(own, live, day);
};

/** A plan a member may switch to today: it must be on sale right now. */
export const loadLivePlan = (db: Db, feePlanId: bigint, day: Date): Promise<RenewalPlan | null> =>
  db.feePlan.findFirst({ where: { ...liveWhere(day), id: feePlanId }, select: PLAN_SELECT });

export const durationOf = (plan: RenewalPlan): number => CYCLE_MONTHS[plan.billing_cycle];

/** Whole-month pro-rata (decision 2026-08-21), tax per line rounded to 2 dp. */
export const priceRenewal = (
  amount: Prisma.Decimal,
  taxRate: Prisma.Decimal,
  window: Pick<TermWindow, 'months' | 'durationMonths' | 'prorated'>,
) => {
  const net = window.prorated
    ? amount.mul(window.months).div(window.durationMonths).toDecimalPlaces(2)
    : amount;
  const tax = net.mul(taxRate).div(100).toDecimalPlaces(2);

  return { net, tax, total: net.add(tax) };
};
