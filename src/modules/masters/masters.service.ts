import { Prisma } from '@prisma/client';
import type { FeeType } from '@prisma/client';
import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import * as repo from '@modules/masters/masters.repository';
import type {
  CreateCategoryInput,
  CreateDocumentTypeInput,
  CreateFeeInput,
  CreateTierInput,
  UpdateCategoryInput,
  UpdateDocumentTypeInput,
  UpdateFeeInput,
  UpdateTierInput,
} from '@modules/masters/masters.types';
import { AppError } from '@utils/appError';

/**
 * Business rules for the membership catalogue (M2).
 *
 * Two rules shape almost everything here:
 *
 *  1. **Deactivate, never delete.** A category or tier that has priced an invoice
 *     or classified a member must stay resolvable forever, so `is_active=false`
 *     is the retirement mechanism and delete is refused the moment anything
 *     depends on the row.
 *  2. **Prices are append-only.** Changing an amount creates a new row with a new
 *     `effective_from`; the old row is closed. That is what keeps last year's
 *     invoice explainable (billing-payment.md §2).
 */

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const notFound = (key: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: key });

const conflict = (key: string, details?: Record<string, unknown>): AppError =>
  new AppError({
    errorType: ERROR_TYPES.CONFLICT,
    messageKey: key,
    ...(details ? { details } : {}),
  });

/**
 * Postgres exclusion-constraint violation — two active prices covering the same day.
 *
 * Matching on the message is not laziness. Prisma maps unique violations to a
 * typed `PrismaClientKnownRequestError` with `code: 'P2002'` and a `meta.target`,
 * but it has no mapping for an **exclusion** violation: it arrives as a
 * `PrismaClientUnknownRequestError` with `code` and `meta` both undefined, and the
 * only identifying detail — SQLSTATE `23P01` and the constraint name — is inside
 * the message string. Checking both keeps this from firing on an unrelated error.
 */
const OVERLAP_CONSTRAINT = 'FeeStructures_no_overlapping_active_price';

const isOverlapViolation = (error: unknown): boolean => {
  if (
    !(error instanceof Prisma.PrismaClientUnknownRequestError) &&
    !(error instanceof Prisma.PrismaClientKnownRequestError)
  ) {
    return false;
  }

  const message = String(error.message);

  return message.includes('23P01') && message.includes(OVERLAP_CONSTRAINT);
};

const audited = (actor: Actor) => ({
  actorType: 'ADMIN' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

const paged = <T extends { total: bigint }>(rows: T[]): { rows: T[]; total: number } => ({
  rows,
  total: rows.length > 0 ? Number(rows[0]!.total) : 0,
});

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `active` -> true, `inactive` -> false, both or neither -> no filter.
 *
 * Returning `undefined` for "both" matters: it is not the same as passing a
 * two-element list the database has to test every row against, and it keeps the
 * query plan identical to the unfiltered one.
 */
const selectedActiveState = (status: string | undefined): boolean | undefined => {
  if (!status) return undefined;

  const chosen = new Set(status.split(','));

  if (chosen.size !== 1) return undefined;

  return chosen.has('active');
};

export const listCategories = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  activeOnly?: boolean | undefined;
  status?: string | undefined;
  created_from?: string | undefined;
  created_to?: string | undefined;
}) =>
  paged(
    await repo.listCategories(prisma, {
      search: query.search,
      activeOnly: query.activeOnly,
      // The column is a boolean, so a multi-select over two states collapses to
      // a nullable boolean: one value filters, both values (or none) select
      // everything and are therefore the same as no filter at all. Doing it here
      // keeps array binding out of the SQL entirely.
      isActive: selectedActiveState(query.status),
      createdFrom: query.created_from,
      createdTo: query.created_to,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const getCategory = async (id: bigint) => {
  const row = await repo.findCategoryById(prisma, id);
  if (!row) throw notFound('masters.categoryNotFound');

  return row;
};

export const createCategory = async (input: CreateCategoryInput, actor: Actor) => {
  if (await repo.findCategoryByCode(prisma, input.code)) {
    throw conflict('masters.categoryCodeExists');
  }

  return prisma.$transaction(async (tx) => {
    const created = await repo.createCategory(tx, input);

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.CATEGORY_CREATED,
      entityName: 'MembershipCategories',
      entityId: created.id,
      after: { code: created.code, name: created.name, is_active: created.is_active },
    });

    return created;
  });
};

export const updateCategory = async (id: bigint, input: UpdateCategoryInput, actor: Actor) => {
  const existing = await getCategory(id);

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateCategory(tx, id, input);

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.CATEGORY_UPDATED,
      entityName: 'MembershipCategories',
      entityId: id,
      before: { name: existing.name, is_active: existing.is_active },
      after: { name: updated.name, is_active: updated.is_active },
    });

    return updated;
  });
};

export const deleteCategory = async (id: bigint, actor: Actor) => {
  const existing = await getCategory(id);
  const dependents = await repo.countCategoryDependents(prisma, id);

  // The message carries the counts so the admin screen can say *why* rather than
  // just refusing (AJ-4). Deactivating is the intended alternative.
  if (dependents.tiers > 0 || dependents.fees > 0) {
    throw conflict('masters.categoryInUse', dependents);
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateCategory(tx, id, { deletedAt: new Date(), is_active: false });

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.CATEGORY_DELETED,
      entityName: 'MembershipCategories',
      entityId: id,
      before: { code: existing.code, name: existing.name },
    });
  });
};

/* -------------------------------------------------------------------------- */
/* Tiers                                                                       */
/* -------------------------------------------------------------------------- */

export const listTiers = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  activeOnly?: boolean | undefined;
  category_id?: string | undefined;
  status?: string | undefined;
  created_from?: string | undefined;
  created_to?: string | undefined;
}) =>
  paged(
    await repo.listTiers(prisma, {
      // Handed down as the CSV it arrived as. The repositories expand it with
      // `string_to_array` inside SQL, which keeps one bound parameter per
      // filter however many values it carries.
      categoryIds: query.category_id,
      isActive: selectedActiveState(query.status),
      createdFrom: query.created_from,
      createdTo: query.created_to,
      search: query.search,
      activeOnly: query.activeOnly,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const createTier = async (input: CreateTierInput, actor: Actor) => {
  const categoryId = BigInt(input.category_id);
  await getCategory(categoryId);

  if (await repo.findTierByCode(prisma, categoryId, input.code)) {
    throw conflict('masters.tierCodeExists');
  }

  return prisma.$transaction(async (tx) => {
    const created = await repo.createTier(tx, {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      display_order: input.display_order,
      is_active: input.is_active,
      category: { connect: { id: categoryId } },
    });

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.TIER_CREATED,
      entityName: 'MembershipTiers',
      entityId: created.id,
      after: { code: created.code, name: created.name, category_id: categoryId.toString() },
    });

    return created;
  });
};

export const updateTier = async (id: bigint, input: UpdateTierInput, actor: Actor) => {
  const existing = await repo.findTierById(prisma, id);
  if (!existing) throw notFound('masters.tierNotFound');

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateTier(tx, id, input);

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.TIER_UPDATED,
      entityName: 'MembershipTiers',
      entityId: id,
      before: { name: existing.name, is_active: existing.is_active },
      after: { name: updated.name, is_active: updated.is_active },
    });

    return updated;
  });
};

export const deleteTier = async (id: bigint, actor: Actor) => {
  const existing = await repo.findTierById(prisma, id);
  if (!existing) throw notFound('masters.tierNotFound');

  const dependents = await repo.countTierDependents(prisma, id);
  if (dependents.fees > 0) throw conflict('masters.tierInUse', dependents);

  await prisma.$transaction(async (tx) => {
    await repo.updateTier(tx, id, { deletedAt: new Date(), is_active: false });

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.TIER_DELETED,
      entityName: 'MembershipTiers',
      entityId: id,
      before: { code: existing.code, name: existing.name },
    });
  });
};

/* -------------------------------------------------------------------------- */
/* Fees                                                                        */
/* -------------------------------------------------------------------------- */

export const listFees = async (query: {
  page: number;
  limit: number;
  activeOnly?: boolean | undefined;
  category_id?: string | undefined;
  fee_type?: string | undefined;
  search?: string | undefined;
  status?: string | undefined;
  effective_from?: string | undefined;
  effective_to?: string | undefined;
  created_from?: string | undefined;
  created_to?: string | undefined;
}) =>
  paged(
    await repo.listFees(prisma, {
      categoryIds: query.category_id,
      feeTypes: query.fee_type,
      isActive: selectedActiveState(query.status),
      effectiveFrom: query.effective_from,
      effectiveTo: query.effective_to,
      createdFrom: query.created_from,
      createdTo: query.created_to,
      activeOnly: query.activeOnly,
      search: query.search,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const createFee = async (input: CreateFeeInput, actor: Actor) => {
  const categoryId = input.category_id ? BigInt(input.category_id) : null;
  if (categoryId) await getCategory(categoryId);

  if (input.tier_id) {
    if (!categoryId) throw conflict('masters.tierCategoryMismatch');
    const tier = await repo.findTierById(prisma, BigInt(input.tier_id));
    if (!tier) throw notFound('masters.tierNotFound');
    // A tier priced under someone else's category would resolve for neither.
    if (tier.category_id !== categoryId) throw conflict('masters.tierCategoryMismatch');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await repo.createFee(tx, {
        category_id: categoryId,
        tier_id: input.tier_id ? BigInt(input.tier_id) : null,
        fee_type: input.fee_type,
        amount: new Prisma.Decimal(input.amount),
        tax_rate: new Prisma.Decimal(input.tax_rate ?? '0'),
        duration_months: input.duration_months,
        effective_from: new Date(input.effective_from),
        effective_to: input.effective_to ? new Date(input.effective_to) : null,
        is_active: input.is_active,
        notes: input.notes ?? null,
      });

      await writeAudit(tx, {
        ...audited(actor),
        action: AUDIT_ACTIONS.FEE_CREATED,
        entityName: 'FeeStructures',
        entityId: created.id,
        after: {
          category_id: created.category_id?.toString() ?? null,
          tier_id: created.tier_id?.toString() ?? null,
          fee_type: created.fee_type,
          amount: created.amount.toFixed(2),
          tax_rate: created.tax_rate.toFixed(2),
          effective_from: input.effective_from,
          effective_to: input.effective_to ?? null,
        },
      });

      return created;
    });
  } catch (error) {
    // The database, not the service, is the authority on overlap — it holds the
    // exclusion constraint, so it also wins any race between two admins saving
    // at once. The service just translates the violation into something an admin
    // can act on.
    if (isOverlapViolation(error)) throw conflict('masters.feeOverlap');
    throw error;
  }
};

export const updateFee = async (id: bigint, input: UpdateFeeInput, actor: Actor) => {
  const existing = await repo.findFeeById(prisma, id);
  if (!existing) throw notFound('masters.feeNotFound');

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await repo.updateFee(tx, id, {
        ...(input.effective_to !== undefined
          ? { effective_to: input.effective_to ? new Date(input.effective_to) : null }
          : {}),
        ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });

      await writeAudit(tx, {
        ...audited(actor),
        action: AUDIT_ACTIONS.FEE_UPDATED,
        entityName: 'FeeStructures',
        entityId: id,
        before: {
          effective_to: existing.effective_to?.toISOString().slice(0, 10) ?? null,
          is_active: existing.is_active,
        },
        after: {
          effective_to: updated.effective_to?.toISOString().slice(0, 10) ?? null,
          is_active: updated.is_active,
        },
      });

      return updated;
    });
  } catch (error) {
    if (isOverlapViolation(error)) throw conflict('masters.feeOverlap');
    throw error;
  }
};

/**
 * What would we charge for this, on this date?
 *
 * Shared by the admin preview, M4 approval, M5 invoicing and M6 renewal. When
 * nothing matches it throws rather than returning zero: a silent ₹0 invoice is
 * far worse than a blocked approval that names the missing configuration
 * (billing-payment.md §2).
 */
export const resolveFee = async (params: {
  categoryId: bigint;
  tierId?: bigint | null;
  feeType: FeeType;
  onDate?: Date;
}) => {
  const row = await repo.resolveFee(prisma, {
    categoryId: params.categoryId,
    tierId: params.tierId ?? null,
    feeType: params.feeType,
    onDate: params.onDate ?? new Date(),
  });

  if (!row) throw conflict('masters.noFeeConfigured');

  const amount = row.amount;
  const taxAmount = amount.mul(row.tax_rate).div(100).toDecimalPlaces(2);

  return {
    fee_structure_id: row.id.toString(),
    category_id: row.category_id?.toString() ?? null,
    category_name: row.category_name,
    tier_id: row.tier_id?.toString() ?? null,
    tier_name: row.tier_name,
    fee_type: row.fee_type,
    // Money leaves as a 2-decimal string, never a JSON number (api-conventions.md §1).
    amount: amount.toFixed(2),
    tax_rate: row.tax_rate.toFixed(2),
    tax_amount: taxAmount.toFixed(2),
    total_amount: amount.add(taxAmount).toFixed(2),
    currency: row.currency,
    duration_months: row.duration_months,
    effective_from: row.effective_from.toISOString().slice(0, 10),
    effective_to: row.effective_to?.toISOString().slice(0, 10) ?? null,
  };
};

/**
 * The price the applicant actually chose, priced the same way as any other.
 *
 * `resolveFee` answers "what would we charge for this category today"; this
 * answers "what did this person agree to pay". They exist side by side because
 * a plan picked in March and approved in June must be honoured at March's
 * figure — the same rule the event booking already keeps, where the price is
 * fixed when you book rather than when you pay.
 *
 * Still refuses rather than inventing a number. A plan the admin has since
 * deleted or retired throws, and the approval is blocked and names the problem,
 * exactly as a missing category price does.
 */
export const feeById = async (feeStructureId: bigint) => {
  const row = await prisma.feeStructure.findFirst({
    where: { id: feeStructureId, deletedAt: null },
    include: {
      category: { select: { name: true } },
      tier: { select: { name: true } },
    },
  });

  if (!row) throw conflict('masters.noFeeConfigured');

  const taxAmount = row.amount.mul(row.tax_rate).div(100).toDecimalPlaces(2);

  return {
    fee_structure_id: row.id.toString(),
    category_id: row.category_id?.toString() ?? null,
    category_name: row.category?.name ?? null,
    tier_id: row.tier_id?.toString() ?? null,
    tier_name: row.tier?.name ?? null,
    fee_type: row.fee_type,
    amount: row.amount.toFixed(2),
    tax_rate: row.tax_rate.toFixed(2),
    tax_amount: taxAmount.toFixed(2),
    total_amount: row.amount.add(taxAmount).toFixed(2),
    currency: row.currency,
    duration_months: row.duration_months,
    effective_from: row.effective_from.toISOString().slice(0, 10),
    effective_to: row.effective_to?.toISOString().slice(0, 10) ?? null,
  };
};

/* -------------------------------------------------------------------------- */
/* Document types                                                              */
/* -------------------------------------------------------------------------- */

export const listDocumentTypes = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  activeOnly?: boolean | undefined;
  applies_to?: string | undefined;
  sides?: string | undefined;
  status?: string | undefined;
  created_from?: string | undefined;
  created_to?: string | undefined;
}) =>
  paged(
    await repo.listDocumentTypes(prisma, {
      appliesTo: query.applies_to,
      sides: query.sides,
      isActive: selectedActiveState(query.status),
      createdFrom: query.created_from,
      createdTo: query.created_to,
      search: query.search,
      activeOnly: query.activeOnly,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const createDocumentType = async (input: CreateDocumentTypeInput, actor: Actor) => {
  if (await repo.findDocumentTypeByCode(prisma, input.code)) {
    throw conflict('masters.documentTypeCodeExists');
  }

  return prisma.$transaction(async (tx) => {
    const created = await repo.createDocumentType(tx, {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      applies_to: input.applies_to,
      is_required: input.is_required,
      max_size_mb: input.max_size_mb,
      allowed_mime: input.allowed_mime,
      display_order: input.display_order,
      is_active: input.is_active,
    });

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.DOCUMENT_TYPE_CREATED,
      entityName: 'DocumentTypes',
      entityId: created.id,
      after: { code: created.code, name: created.name, is_required: created.is_required },
    });

    return created;
  });
};

export const updateDocumentType = async (
  id: bigint,
  input: UpdateDocumentTypeInput,
  actor: Actor,
) => {
  const existing = await repo.findDocumentTypeById(prisma, id);
  if (!existing) throw notFound('masters.documentTypeNotFound');

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateDocumentType(tx, id, input);

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.DOCUMENT_TYPE_UPDATED,
      entityName: 'DocumentTypes',
      entityId: id,
      before: {
        name: existing.name,
        is_required: existing.is_required,
        is_active: existing.is_active,
      },
      after: { name: updated.name, is_required: updated.is_required, is_active: updated.is_active },
    });

    return updated;
  });
};

export const deleteDocumentType = async (id: bigint, actor: Actor) => {
  const existing = await repo.findDocumentTypeById(prisma, id);
  if (!existing) throw notFound('masters.documentTypeNotFound');

  /*
    Refuse while anything points at it.

    This guard is the whole reason the ApplicationDocuments foreign key can be
    restored. Retiring a type out from under a live application is what broke
    registration on 2026-08-24 and caused the FK to be replaced by an enum;
    `onDelete: Restrict` does not help, because a soft delete is an UPDATE and
    Postgres never sees a violation. `is_active = false` is the correct way to
    stop offering a type that has already been used.
  */
  if ((await repo.countDocumentTypeUsage(prisma, id)) > 0) {
    throw conflict('masters.documentTypeInUse');
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateDocumentType(tx, id, { deletedAt: new Date(), is_active: false });

    await writeAudit(tx, {
      ...audited(actor),
      action: AUDIT_ACTIONS.DOCUMENT_TYPE_DELETED,
      entityName: 'DocumentTypes',
      entityId: id,
      before: { code: existing.code, name: existing.name },
    });
  });
};

/* -------------------------------------------------------------------------- */
/* Public catalogue                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The membership plans on offer today (C-03).
 *
 * One row per published "new membership" price that is live on this date, and
 * the term is what tells them apart: 12 months at one figure, 24 at another, 36
 * at a third. The applicant picks one and the id travels with them to signup, so
 * the figure on the card is the figure on the invoice.
 *
 * Category-specific prices are excluded rather than merged in. A plan the whole
 * public may choose cannot be one that only members of a particular class are
 * eligible for, and showing a price nobody can select is worse than showing one
 * fewer.
 *
 * The field list is an explicit allowlist: `notes` is internal, and the
 * effective dates are the association's own scheduling rather than the
 * applicant's business.
 */
export const publicPlans = async (onDate = new Date()) => {
  const rows = await prisma.feeStructure.findMany({
    where: {
      deletedAt: null,
      is_active: true,
      fee_type: 'NEW_MEMBERSHIP',
      category_id: null,
      tier_id: null,
      effective_from: { lte: onDate },
      OR: [{ effective_to: null }, { effective_to: { gte: onDate } }],
    },
    orderBy: [{ duration_months: 'asc' }, { amount: 'asc' }],
    select: {
      id: true,
      amount: true,
      tax_rate: true,
      currency: true,
      duration_months: true,
    },
  });

  return rows.map((row) => {
    // Rounded at the line, exactly as the invoice does it, so the card and the
    // bill agree to the paisa rather than to within a rupee.
    const taxAmount = row.amount.mul(row.tax_rate).div(100).toDecimalPlaces(2);

    return {
      id: row.id.toString(),
      // Money leaves as a 2-decimal string, never a JSON number (ADR-007).
      amount: row.amount.toFixed(2),
      tax_rate: row.tax_rate.toFixed(2),
      tax_amount: taxAmount.toFixed(2),
      total_amount: row.amount.add(taxAmount).toFixed(2),
      currency: row.currency,
      duration_months: row.duration_months,
    };
  });
};

/**
 * What an anonymous visitor sees on the membership page (C-03).
 *
 * Active categories, their active tiers, and today's price for each — assembled
 * from the same resolver the invoicing code uses, so the number quoted publicly
 * and the number billed can never drift apart.
 *
 * The field list is an explicit allowlist. `notes` is internal, inactive rows are
 * not offerings, and nothing here may leak a row the admin has retired.
 * A category with no configured price is returned with `fee: null` rather than
 * being hidden: the page then says "fee on application" instead of silently
 * dropping a membership type the federation offers.
 */
export const publicCatalogue = async () => {
  const categories = await prisma.membershipCategory.findMany({
    where: { deletedAt: null, is_active: true },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      tiers: {
        where: { deletedAt: null, is_active: true },
        orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
        select: { id: true, code: true, name: true, description: true },
      },
    },
  });

  const priceFor = async (categoryId: bigint, tierId: bigint | null) => {
    try {
      const fee = await resolveFee({
        categoryId,
        tierId,
        feeType: 'NEW_MEMBERSHIP' as FeeType,
      });

      return {
        amount: fee.amount,
        tax_rate: fee.tax_rate,
        tax_amount: fee.tax_amount,
        total_amount: fee.total_amount,
        currency: fee.currency,
        duration_months: fee.duration_months,
      };
    } catch {
      // No active price today. Not an error on a public page — the federation may
      // simply not have published one yet (OQ-2).
      return null;
    }
  };

  return Promise.all(
    categories.map(async (category) => ({
      id: category.id.toString(),
      code: category.code,
      name: category.name,
      description: category.description,
      fee: category.tiers.length > 0 ? null : await priceFor(category.id, null),
      tiers: await Promise.all(
        category.tiers.map(async (tier) => ({
          code: tier.code,
          name: tier.name,
          description: tier.description,
          fee: await priceFor(category.id, tier.id),
        })),
      ),
    })),
  );
};
