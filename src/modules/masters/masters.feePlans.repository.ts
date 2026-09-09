import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Data access for the redesigned price list. No rules here — the service owns those (RULES.md).
 */

/** Every plan a structure holds, live and superseded alike, newest price first per cycle. */
const planInclude = {
  orderBy: [{ billing_cycle: 'asc' as const }, { effective_from: 'desc' as const }],
  where: { deletedAt: null },
};

export const listStructures = async (
  db: Db,
  params: {
    skip: number;
    take: number;
    search?: string;
    status?: string[];
    createdFrom?: Date;
    createdTo?: Date;
    effectiveFrom?: Date;
    effectiveTo?: Date;
  },
) => {
  const where: Prisma.FeePlanStructureWhereInput = {
    deletedAt: null,
    ...(params.search ? { name: { contains: params.search, mode: 'insensitive' } } : {}),
    ...(params.status && params.status.length === 1
      ? { is_active: params.status[0] === 'active' }
      : {}),
    ...(params.createdFrom || params.createdTo
      ? {
          createdAt: {
            ...(params.createdFrom ? { gte: params.createdFrom } : {}),
            ...(params.createdTo ? { lte: params.createdTo } : {}),
          },
        }
      : {}),
    /*
      `some`, not a column on the structure: the effective date belongs to a
      price, and a list is "effective in March" when any price in it is.
    */
    ...(params.effectiveFrom || params.effectiveTo
      ? {
          plans: {
            some: {
              deletedAt: null,
              effective_from: {
                ...(params.effectiveFrom ? { gte: params.effectiveFrom } : {}),
                ...(params.effectiveTo ? { lte: params.effectiveTo } : {}),
              },
            },
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.feePlanStructure.findMany({
      where,
      include: {
        plans: planInclude,
        /* Names rather than ids: a column of admin ids is not something anybody
           can read, and looking each one up per row is a query per row. */
        created_by: { select: { full_name: true } },
        updated_by: { select: { full_name: true } },
      },
      orderBy: [{ is_active: 'desc' }, { createdAt: 'desc' }],
      skip: params.skip,
      take: params.take,
    }),
    db.feePlanStructure.count({ where }),
  ]);

  return { rows, total };
};

export const findStructureById = (db: Db, id: bigint) =>
  db.feePlanStructure.findFirst({
    where: { id, deletedAt: null },
    include: {
      plans: planInclude,
      created_by: { select: { full_name: true } },
      updated_by: { select: { full_name: true } },
    },
  });

export const createStructure = (db: Db, data: { name: string; created_by_admin_id: bigint }) =>
  db.feePlanStructure.create({
    // The publisher is also the last person to have touched it, until somebody else does.
    data: { ...data, updated_by_admin_id: data.created_by_admin_id },
  });

export const renameStructure = (db: Db, id: bigint, name: string, adminId: bigint) =>
  db.feePlanStructure.update({
    where: { id },
    data: { name, updated_by_admin_id: adminId },
  });

export const setStructureActive = (db: Db, id: bigint, is_active: boolean, adminId: bigint) =>
  db.feePlanStructure.update({
    where: { id },
    data: { is_active, updated_by_admin_id: adminId },
  });

/**
 * Stamped on every write that changes a structure's plans without changing its
 * name — the grid save, which is most of them.
 */
export const touchStructure = (db: Db, id: bigint, adminId: bigint) =>
  db.feePlanStructure.update({ where: { id }, data: { updated_by_admin_id: adminId } });

export const createPlan = (db: Db, data: Prisma.FeePlanUncheckedCreateInput) =>
  db.feePlan.create({ data });

export const updatePlan = (db: Db, id: bigint, data: Prisma.FeePlanUncheckedUpdateInput) =>
  db.feePlan.update({ where: { id }, data });

/**
 * Close a plan: stop offering it, and end its date range the day before its replacement starts.
 *
 * Both halves matter. `is_active = false` takes it off the website; the end date is what lets a
 * replacement exist at all, because the exclusion constraint compares live date ranges and an
 * open-ended row overlaps everything after it.
 */
export const closePlan = (db: Db, id: bigint, effective_to: Date) =>
  db.feePlan.update({ where: { id }, data: { is_active: false, effective_to } });

/**
 * How many members hold a term priced from each of these plans, and whether any invoice quotes
 * them.
 *
 * These two numbers decide whether an edit may write in place or must fork, so they are read
 * from the terms and invoice lines themselves rather than cached on the plan — a counter that
 * drifts here would let a billed price be silently overwritten.
 */
export const planUsage = async (db: Db, planIds: bigint[]) => {
  if (planIds.length === 0) return new Map<string, { members: number; billed: boolean }>();

  const [terms, items] = await Promise.all([
    db.membershipTerm.groupBy({
      by: ['fee_plan_id'],
      where: { fee_plan_id: { in: planIds } },
      _count: { _all: true },
    }),
    db.invoiceItem.groupBy({
      by: ['fee_plan_id'],
      where: { fee_plan_id: { in: planIds } },
      _count: { _all: true },
    }),
  ]);

  const usage = new Map<string, { members: number; billed: boolean }>();
  planIds.forEach((id) => usage.set(id.toString(), { members: 0, billed: false }));

  terms.forEach((t) => {
    if (t.fee_plan_id === null) return;
    const key = t.fee_plan_id.toString();
    usage.set(key, { ...usage.get(key)!, members: t._count._all });
  });

  items.forEach((i) => {
    if (i.fee_plan_id === null) return;
    const key = i.fee_plan_id.toString();
    usage.set(key, { ...usage.get(key)!, billed: i._count._all > 0 });
  });

  return usage;
};

/** Live plans for a cycle held by any OTHER structure — the D-3 clash check. */
export const liveElsewhere = (
  db: Db,
  cycles: Prisma.FeePlanWhereInput['billing_cycle'],
  exceptStructureId: bigint | null,
) =>
  db.feePlan.findMany({
    where: {
      deletedAt: null,
      is_active: true,
      billing_cycle: cycles,
      ...(exceptStructureId === null ? {} : { structure_id: { not: exceptStructureId } }),
    },
    include: { structure: { select: { id: true, name: true } } },
  });
