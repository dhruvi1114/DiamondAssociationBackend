import { Prisma } from '@prisma/client';
import type { BillingCycle, FeePlan } from '@prisma/client';
import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import * as repo from '@modules/masters/masters.feePlans.repository';
import type {
  CreateStructureInput,
  StructureListQuery,
  UpdateStructureInput,
} from '@modules/masters/masters.feePlans.types';
import { AppError } from '@utils/appError';

/**
 * The redesigned price list (M2 redesign).
 * Spec: `docs/specs/2026-09-07-membership-fee-plans.md`.
 *
 * Two rules carry almost everything:
 *
 *  1. **A price that has been invoiced is never edited.** It is closed and a new row takes its
 *     place, so last year's invoice stays explainable. `price_scope` on the new row records
 *     whether the members on the old one come with it — the only moment that intent is knowable.
 *  2. **One live price per cycle per day, across every structure.** The database enforces it with
 *     an exclusion constraint, so a 409 here is that guard firing, not a UI bug. It is also what
 *     makes decision D-3 real: a live structure blocks a new one for the same cycle, and closing
 *     the current list stays a deliberate act rather than a side effect of publishing another.
 */

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const audited = (actor: Actor) => ({
  actorType: 'ADMIN' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

const conflict = (messageKey: string, meta?: Record<string, unknown>) =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey, ...(meta ? { meta } : {}) });

const notFound = (messageKey: string) =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey });

const badRequest = (messageKey: string, meta?: Record<string, unknown>) =>
  new AppError({ errorType: ERROR_TYPES.INVALID_REQUEST, messageKey, ...(meta ? { meta } : {}) });

/**
 * Prisma has no mapping for an exclusion violation: it surfaces as
 * `PrismaClientUnknownRequestError` with `code` and `meta` both undefined and SQLSTATE 23P01 only
 * in the message. The same trap M2's original constraint documented — match on the message.
 */
const isOverlap = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : '';

  return message.includes('23P01') || message.includes('FeePlans_no_overlapping_live_price');
};

const isDuplicateCycle = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('FeePlans_one_live_plan_per_cycle_per_structure');

const dayBefore = (date: Date): Date => {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - 1);

  return d;
};

const sameMoney = (a: Prisma.Decimal, b: string): boolean => a.equals(new Prisma.Decimal(b));

/** The shape the admin screen reads: every plan, plus the two numbers that gate an edit. */
const decorate = async (structures: Awaited<ReturnType<typeof repo.listStructures>>['rows']) => {
  const planIds = structures.flatMap((s) => s.plans.map((p) => p.id));
  const usage = await repo.planUsage(prisma, planIds);

  return structures.map((s) => ({
    ...s,
    /* Flattened to names. The relation objects would reach the screen as
       `created_by.full_name`, which every caller then has to guard for null. */
    created_by: s.created_by?.full_name ?? null,
    updated_by: s.updated_by?.full_name ?? null,
    plans: s.plans.map((p) => {
      const u = usage.get(p.id.toString()) ?? { members: 0, billed: false };

      return { ...p, member_count: u.members, is_billed: u.billed };
    }),
  }));
};

export const listStructures = async (query: StructureListQuery) => {
  const status = query.status ? query.status.split(',').filter(Boolean) : undefined;
  const { rows, total } = await repo.listStructures(prisma, {
    skip: (query.page - 1) * query.limit,
    take: query.limit,
    ...(query.search ? { search: query.search } : {}),
    ...(status ? { status } : {}),
    ...(query.created_from ? { createdFrom: new Date(`${query.created_from}T00:00:00.000Z`) } : {}),
    /*
      The end of the chosen day, not its start. A window of 1st to 1st that
      excluded everything published after midnight would return nothing on the
      day somebody most often asks about — today.
    */
    ...(query.created_to ? { createdTo: new Date(`${query.created_to}T23:59:59.999Z`) } : {}),
    ...(query.effective_from
      ? { effectiveFrom: new Date(`${query.effective_from}T00:00:00.000Z`) }
      : {}),
    ...(query.effective_to ? { effectiveTo: new Date(`${query.effective_to}T23:59:59.999Z`) } : {}),
  });

  return { data: await decorate(rows), total };
};

export const getStructure = async (id: bigint) => {
  const found = await repo.findStructureById(prisma, id);
  if (!found) throw notFound('masters.feePlanStructureNotFound');

  const [decorated] = await decorate([found]);

  return decorated!;
};

/**
 * Refuse a save that would put a second live price on a cycle another list already holds.
 *
 * The exclusion constraint would refuse it anyway, a moment later. Doing it here first is what
 * lets the message name the structure standing in the way, which is the difference between an
 * admin knowing what to close and an admin seeing "conflict".
 */
const assertNoClash = async (cycles: BillingCycle[], exceptStructureId: bigint | null) => {
  const rivals = await repo.liveElsewhere(prisma, { in: cycles }, exceptStructureId);
  if (rivals.length === 0) return;

  const [first] = rivals;
  throw conflict('masters.feePlanCycleAlreadyLive', {
    billing_cycle: first!.billing_cycle,
    structure_id: first!.structure_id.toString(),
    structure_name: first!.structure.name,
  });
};

export const createStructure = async (input: CreateStructureInput, actor: Actor) => {
  const cycles = input.plans.map((p) => p.billing_cycle);
  if (new Set(cycles).size !== cycles.length) throw badRequest('masters.feePlanDuplicateCycle');

  await assertNoClash(cycles, null);

  /*
    Members left on a RETIRED price for one of these cycles.
    
    Under D-3 a live structure blocks a new one, so a price change is normally made by retiring
    the old list and publishing this one — and at that moment nobody has been asked whether those
    members come along. Demanding the answer here is what stops the service inventing it: it used
    to default to ALL_MEMBERS, which moved the very members an admin may have meant to freeze.
  */
  const stranded = await prisma.feePlan.findMany({
    where: { deletedAt: null, is_active: false, billing_cycle: { in: cycles } },
    select: { id: true, billing_cycle: true },
  });

  if (stranded.length > 0) {
    const usage = await repo.planUsage(
      prisma,
      stranded.map((p) => p.id),
    );
    const held = stranded.filter((p) => (usage.get(p.id.toString())?.members ?? 0) > 0);

    if (held.length > 0 && !input.price_scope) {
      throw badRequest('masters.feePlanScopeRequired', {
        cycles: [...new Set(held.map((p) => p.billing_cycle))],
      });
    }
  }

  const effectiveFrom = new Date(input.effective_from);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const structure = await repo.createStructure(tx, {
        name: input.name,
        created_by_admin_id: actor.id,
      });

      for (const plan of input.plans) {
        await repo.createPlan(tx, {
          structure_id: structure.id,
          billing_cycle: plan.billing_cycle,
          name: plan.name,
          amount: new Prisma.Decimal(plan.amount),
          renewal_amount: new Prisma.Decimal(plan.renewal_amount),
          tax_rate: new Prisma.Decimal(plan.tax_rate),
          effective_from: effectiveFrom,
          /* The admin's answer, never a default. Absent only when nobody is affected. */
          price_scope: input.price_scope ?? 'ALL_MEMBERS',
        });
      }

      await writeAudit(tx, {
        ...audited(actor),
        action: AUDIT_ACTIONS.FEE_PLAN_STRUCTURE_CREATED,
        entityName: 'FeePlanStructures',
        entityId: structure.id,
        after: {
          name: input.name,
          cycles,
          effective_from: input.effective_from,
          price_scope: input.price_scope ?? null,
        },
      });

      return structure;
    });

    return await getStructure(created.id);
  } catch (err) {
    if (isOverlap(err)) throw conflict('masters.feePlanOverlap');
    throw err;
  }
};

/**
 * Save a whole structure: publish, reprice, unpublish, all in one transaction.
 *
 * Per cycle, exactly one of four things happens, and which one is decided by the data rather
 * than by the caller:
 *
 *   submitted, no live plan            -> publish a new one
 *   submitted, amounts unchanged       -> write name and tax in place
 *   submitted, amounts changed, unbilled -> write the amounts in place too; no version is kept,
 *                                           because there is no invoice to explain
 *   submitted, amounts changed, billed -> close the old one and publish a replacement, carrying
 *                                         `price_scope`
 *   not submitted, live plan exists    -> close it. It leaves the website and keeps billing the
 *                                         members on it, which is the distinction the screen
 *                                         warns about
 */
export const updateStructure = async (id: bigint, input: UpdateStructureInput, actor: Actor) => {
  const existing = await repo.findStructureById(prisma, id);
  if (!existing) throw notFound('masters.feePlanStructureNotFound');

  const cycles = input.plans.map((p) => p.billing_cycle);
  if (new Set(cycles).size !== cycles.length) throw badRequest('masters.feePlanDuplicateCycle');

  await assertNoClash(cycles, id);

  const live = existing.plans.filter((p) => p.is_active);
  const usage = await repo.planUsage(
    prisma,
    live.map((p) => p.id),
  );
  const effectiveFrom = new Date(input.effective_from);

  const byCycle = new Map<BillingCycle, (typeof live)[number]>();
  live.forEach((p) => byCycle.set(p.billing_cycle, p));

  /* Which submitted rows would fork, so the scope answer can be demanded before anything runs. */
  const forking = input.plans.filter((p) => {
    const current = byCycle.get(p.billing_cycle);
    if (!current) return false;
    if (!(usage.get(current.id.toString())?.billed ?? false)) return false;

    return (
      !sameMoney(current.amount, p.amount) || !sameMoney(current.renewal_amount, p.renewal_amount)
    );
  });

  if (forking.length > 0 && !input.price_scope) {
    throw badRequest('masters.feePlanScopeRequired', {
      cycles: forking.map((p) => p.billing_cycle),
    });
  }

  /* A replacement cannot start on or before the day the price it replaces began. */
  const tooEarly = forking.find((p) => {
    const current = byCycle.get(p.billing_cycle)!;

    return effectiveFrom <= current.effective_from;
  });
  if (tooEarly) {
    throw badRequest('masters.feePlanEffectiveFromTooEarly', {
      billing_cycle: tooEarly.billing_cycle,
      current_effective_from: byCycle
        .get(tooEarly.billing_cycle)!
        .effective_from.toISOString()
        .slice(0, 10),
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (existing.name !== input.name) {
        await repo.renameStructure(tx, id, input.name, actor.id);
      } else {
        // The grid changed even though the name did not; the list still moved.
        await repo.touchStructure(tx, id, actor.id);
      }

      const submitted = new Set(cycles);

      /* Close first, publish second: the exclusion constraint is checked per statement, so an
         open-ended row still live when its replacement is inserted would refuse the insert. */
      for (const current of live) {
        if (submitted.has(current.billing_cycle)) continue;
        await repo.closePlan(tx, current.id, dayBefore(effectiveFrom));
      }

      for (const plan of input.plans) {
        const current = byCycle.get(plan.billing_cycle);

        if (!current) {
          await repo.createPlan(tx, {
            structure_id: id,
            billing_cycle: plan.billing_cycle,
            name: plan.name,
            amount: new Prisma.Decimal(plan.amount),
            renewal_amount: new Prisma.Decimal(plan.renewal_amount),
            tax_rate: new Prisma.Decimal(plan.tax_rate),
            effective_from: effectiveFrom,
            price_scope: input.price_scope ?? 'ALL_MEMBERS',
          });
          continue;
        }

        const willFork = forking.some((f) => f.billing_cycle === plan.billing_cycle);

        if (!willFork) {
          await repo.updatePlan(tx, current.id, {
            name: plan.name,
            amount: new Prisma.Decimal(plan.amount),
            renewal_amount: new Prisma.Decimal(plan.renewal_amount),
            tax_rate: new Prisma.Decimal(plan.tax_rate),
          });
          continue;
        }

        await repo.closePlan(tx, current.id, dayBefore(effectiveFrom));

        const replacement = await repo.createPlan(tx, {
          structure_id: id,
          billing_cycle: plan.billing_cycle,
          name: plan.name,
          amount: new Prisma.Decimal(plan.amount),
          renewal_amount: new Prisma.Decimal(plan.renewal_amount),
          tax_rate: new Prisma.Decimal(plan.tax_rate),
          effective_from: effectiveFrom,
          price_scope: input.price_scope!,
        });

        await writeAudit(tx, {
          ...audited(actor),
          action: AUDIT_ACTIONS.FEE_PLAN_VERSIONED,
          entityName: 'FeePlans',
          entityId: replacement.id,
          before: {
            id: current.id.toString(),
            amount: current.amount.toString(),
            renewal_amount: current.renewal_amount.toString(),
            members_on_it: usage.get(current.id.toString())?.members ?? 0,
          },
          after: {
            amount: plan.amount,
            renewal_amount: plan.renewal_amount,
            effective_from: input.effective_from,
            price_scope: input.price_scope,
          },
        });
      }

      await writeAudit(tx, {
        ...audited(actor),
        action: AUDIT_ACTIONS.FEE_PLAN_STRUCTURE_UPDATED,
        entityName: 'FeePlanStructures',
        entityId: id,
        before: { name: existing.name, cycles: live.map((p) => p.billing_cycle) },
        after: { name: input.name, cycles, price_scope: input.price_scope ?? null },
      });
    });
  } catch (err) {
    if (isDuplicateCycle(err)) throw conflict('masters.feePlanDuplicateCycle');
    if (isOverlap(err)) throw conflict('masters.feePlanOverlap');
    throw err;
  }

  return getStructure(id);
};

/**
 * Retire or restore a whole list.
 *
 * Retiring hides it from the website and refuses new applications. It deliberately does NOT stop
 * it billing: the members already on its plans keep renewing from them, and the row stays because
 * it is the only record of what they were charged.
 */
export const setStructureActive = async (id: bigint, isActive: boolean, actor: Actor) => {
  const existing = await repo.findStructureById(prisma, id);
  if (!existing) throw notFound('masters.feePlanStructureNotFound');
  if (existing.is_active === isActive) return getStructure(id);

  if (isActive) {
    const cycles = existing.plans.filter((p) => p.is_active).map((p) => p.billing_cycle);
    if (cycles.length > 0) await assertNoClash(cycles, id);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await repo.setStructureActive(tx, id, isActive, actor.id);
      await writeAudit(tx, {
        ...audited(actor),
        action: AUDIT_ACTIONS.FEE_PLAN_STRUCTURE_RETIRED,
        entityName: 'FeePlanStructures',
        entityId: id,
        before: { is_active: existing.is_active },
        after: { is_active: isActive },
      });
    });
  } catch (err) {
    if (isOverlap(err)) throw conflict('masters.feePlanOverlap');
    throw err;
  }

  return getStructure(id);
};

/**
 * What the public membership page renders: the live plans of the live list, one card each.
 *
 * Never the retired ones, whatever they still bill.
 */
export const listPublicPlans = async (): Promise<FeePlan[]> => {
  const today = new Date();

  return prisma.feePlan.findMany({
    where: {
      deletedAt: null,
      is_active: true,
      structure: { is_active: true, deletedAt: null },
      effective_from: { lte: today },
      OR: [{ effective_to: null }, { effective_to: { gte: today } }],
    },
    orderBy: { billing_cycle: 'asc' },
  });
};

/** The month count each cycle buys. Derived, never stored: a plan cannot claim to be quarterly and bill for five months. */
export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  HALF_YEARLY: 6,
  YEARLY: 12,
};

/**
 * Price a chosen plan, in the shape activation already speaks.
 *
 * Deliberately mirrors `masters.feeById` key for key, plus `fee_plan_id` and the plan's name, so
 * approval can take either kind of price without a second code path through the money.
 *
 * It re-checks the plan is live rather than trusting the id on the application: the applicant
 * chose it weeks ago, and a price retired in between must not be quietly charged.
 */
export const feePlanById = async (feePlanId: bigint) => {
  const row = await prisma.feePlan.findFirst({
    where: { id: feePlanId, deletedAt: null },
  });

  if (!row) throw conflict('masters.feePlanStructureNotFound');

  const taxAmount = row.amount.mul(row.tax_rate).div(100).toDecimalPlaces(2);

  return {
    fee_plan_id: row.id.toString(),
    plan_name: row.name,
    billing_cycle: row.billing_cycle,
    amount: row.amount.toFixed(2),
    renewal_amount: row.renewal_amount.toFixed(2),
    tax_rate: row.tax_rate.toFixed(2),
    tax_amount: taxAmount.toFixed(2),
    total_amount: row.amount.add(taxAmount).toFixed(2),
    currency: row.currency,
    duration_months: CYCLE_MONTHS[row.billing_cycle],
    effective_from: row.effective_from.toISOString().slice(0, 10),
    effective_to: row.effective_to?.toISOString().slice(0, 10) ?? null,
    is_active: row.is_active,
  };
};
