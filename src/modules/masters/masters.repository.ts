import { Prisma } from '@prisma/client';
import type { DocumentAppliesTo, DocumentSides, FeeType } from '@prisma/client';
import type { Db } from '@db/prisma';

/**
 * Data access for the membership catalogue.
 *
 * Read strategy is ADR-005's hybrid: list endpoints are raw parameterised SQL —
 * one statement, joins instead of loops, a windowed total, and only the columns
 * the screen renders. Point reads and writes use the typed client, because there
 * the type safety is worth more than the shape control.
 *
 * Every read filters `deletedAt IS NULL`. Soft-deleted rows exist so historic
 * members and invoices still resolve; they are never listed.
 */

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export interface CategoryRow {
  id: bigint;
  code: string;
  name: string;
  description: string | null;
  display_order: number;
  is_active: boolean;
  tier_count: bigint;
  fee_count: bigint;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listCategories = (
  db: Db,
  params: {
    search?: string | undefined;
    activeOnly?: boolean | undefined;
    isActive?: boolean | undefined;
    createdFrom?: string | undefined;
    createdTo?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<CategoryRow[]> => {
  const search = params.search ? `%${params.search}%` : null;

  /*
    Every optional filter is bound as NULL when absent and switched off inside
    the SQL, rather than concatenated into the statement. One prepared statement
    serves every combination of filters — the plan is cached once instead of per
    permutation, and there is no string building anywhere near a WHERE clause.
  */
  const isActive = params.isActive ?? null;
  const createdFrom = params.createdFrom ?? null;
  const createdTo = params.createdTo ?? null;

  // The counts come from correlated subqueries rather than a second round trip:
  // the admin screen needs them to explain why a category cannot be deleted, and
  // an N+1 here would be one query per row (database-indexes.md).
  return db.$queryRaw<CategoryRow[]>`
    SELECT c.id,
           c.code,
           c.name,
           c.description,
           c.display_order,
           c.is_active,
           (SELECT count(*) FROM "MembershipTiers" t
              WHERE t.category_id = c.id AND t."deletedAt" IS NULL)   AS tier_count,
           (SELECT count(*) FROM "FeeStructures" f
              WHERE f.category_id = c.id AND f."deletedAt" IS NULL)   AS fee_count,
           c."createdAt",
           c."updatedAt",
           count(*) OVER ()                                           AS total
      FROM "MembershipCategories" c
     WHERE c."deletedAt" IS NULL
       AND (${params.activeOnly ?? false} = false OR c.is_active = true)
       AND (${search}::text IS NULL OR c.name ILIKE ${search} OR c.code ILIKE ${search})
       AND (${isActive}::boolean IS NULL OR c.is_active = ${isActive}::boolean)
       -- Cast both sides to ::date so a row created at 14:05 today still falls
       -- inside a range whose "to" is today.
       AND (${createdFrom}::date IS NULL OR c."createdAt"::date >= ${createdFrom}::date)
       AND (${createdTo}::date IS NULL OR c."createdAt"::date <= ${createdTo}::date)
     ORDER BY c.display_order ASC, c.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export const findCategoryById = (db: Db, id: bigint) =>
  db.membershipCategory.findFirst({ where: { id, deletedAt: null } });

export const findCategoryByCode = (db: Db, code: string) =>
  db.membershipCategory.findFirst({ where: { code, deletedAt: null } });

export const createCategory = (db: Db, data: Prisma.MembershipCategoryCreateInput) =>
  db.membershipCategory.create({ data });

export const updateCategory = (db: Db, id: bigint, data: Prisma.MembershipCategoryUpdateInput) =>
  db.membershipCategory.update({ where: { id }, data });

/** Counts of the things that make a category undeletable. */
export const countCategoryDependents = async (
  db: Db,
  id: bigint,
): Promise<{ tiers: number; fees: number }> => {
  const [tiers, fees] = await Promise.all([
    db.membershipTier.count({ where: { category_id: id, deletedAt: null } }),
    db.feeStructure.count({ where: { category_id: id, deletedAt: null } }),
  ]);

  return { tiers, fees };
};

/* -------------------------------------------------------------------------- */
/* Tiers                                                                       */
/* -------------------------------------------------------------------------- */

export interface TierRow {
  id: bigint;
  category_id: bigint;
  category_name: string;
  code: string;
  name: string;
  description: string | null;
  display_order: number;
  is_active: boolean;
  fee_count: bigint;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listTiers = (
  db: Db,
  params: {
    /** CSV of ids; expanded with `string_to_array` so one bind covers any count. */
    categoryIds?: string | undefined;
    isActive?: boolean | undefined;
    createdFrom?: string | undefined;
    createdTo?: string | undefined;
    search?: string | undefined;
    activeOnly?: boolean | undefined;
    limit: number;
    offset: number;
  },
): Promise<TierRow[]> => {
  const search = params.search ? `%${params.search}%` : null;

  return db.$queryRaw<TierRow[]>`
    SELECT t.id,
           t.category_id,
           c.name AS category_name,
           t.code,
           t.name,
           t.description,
           t.display_order,
           t.is_active,
           (SELECT count(*) FROM "FeeStructures" f
              WHERE f.tier_id = t.id AND f."deletedAt" IS NULL) AS fee_count,
           t."createdAt",
           t."updatedAt",
           count(*) OVER ()                                     AS total
      FROM "MembershipTiers" t
      JOIN "MembershipCategories" c ON c.id = t.category_id
     WHERE t."deletedAt" IS NULL
       AND (${params.categoryIds ?? null}::text IS NULL
            OR t.category_id = ANY(string_to_array(${params.categoryIds ?? null}, ',')::bigint[]))
       AND (${params.isActive ?? null}::boolean IS NULL OR t.is_active = ${params.isActive ?? null}::boolean)
       AND (${params.createdFrom ?? null}::date IS NULL OR t."createdAt"::date >= ${params.createdFrom ?? null}::date)
       AND (${params.createdTo ?? null}::date IS NULL OR t."createdAt"::date <= ${params.createdTo ?? null}::date)
       AND (${params.activeOnly ?? false} = false OR t.is_active = true)
       AND (${search}::text IS NULL OR t.name ILIKE ${search} OR t.code ILIKE ${search})
     ORDER BY c.display_order ASC, t.display_order ASC, t.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export const findTierById = (db: Db, id: bigint) =>
  db.membershipTier.findFirst({ where: { id, deletedAt: null } });

export const findTierByCode = (db: Db, categoryId: bigint, code: string) =>
  db.membershipTier.findFirst({ where: { category_id: categoryId, code, deletedAt: null } });

export const createTier = (db: Db, data: Prisma.MembershipTierCreateInput) =>
  db.membershipTier.create({ data });

export const updateTier = (db: Db, id: bigint, data: Prisma.MembershipTierUpdateInput) =>
  db.membershipTier.update({ where: { id }, data });

export const countTierDependents = async (db: Db, id: bigint): Promise<{ fees: number }> => ({
  fees: await db.feeStructure.count({ where: { tier_id: id, deletedAt: null } }),
});

/* -------------------------------------------------------------------------- */
/* Fees                                                                        */
/* -------------------------------------------------------------------------- */

export interface FeeRow {
  id: bigint;
  category_id: bigint | null;
  category_name: string | null;
  tier_id: bigint | null;
  tier_name: string | null;
  fee_type: FeeType;
  amount: Prisma.Decimal;
  tax_rate: Prisma.Decimal;
  currency: string;
  duration_months: number;
  effective_from: Date;
  effective_to: Date | null;
  is_active: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listFees = (
  db: Db,
  params: {
    categoryIds?: string | undefined;
    feeTypes?: string | undefined;
    isActive?: boolean | undefined;
    effectiveFrom?: string | undefined;
    effectiveTo?: string | undefined;
    createdFrom?: string | undefined;
    createdTo?: string | undefined;
    activeOnly?: boolean | undefined;
    search?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<FeeRow[]> => {
  /*
    A fee row has no name of its own — it is identified by what it prices. So the
    search matches the category and tier it points at, and the note explaining
    why the price is what it is, which is the only free text on the row and the
    thing an admin looks a price up by ("the 2026 resolution").
  */
  const search = params.search ? `%${params.search}%` : null;

  return db.$queryRaw<FeeRow[]>`
    SELECT f.id,
           f.category_id,
           c.name AS category_name,
           f.tier_id,
           t.name AS tier_name,
           f.fee_type,
           f.amount,
           f.tax_rate,
           f.currency,
           f.duration_months,
           f.effective_from,
           f.effective_to,
           f.is_active,
           f.notes,
           f."createdAt",
           f."updatedAt",
           count(*) OVER () AS total
      FROM "FeeStructures" f
      LEFT JOIN "MembershipCategories" c ON c.id = f.category_id
      LEFT JOIN "MembershipTiers" t ON t.id = f.tier_id
     WHERE f."deletedAt" IS NULL
       AND (${params.categoryIds ?? null}::text IS NULL
            OR f.category_id = ANY(string_to_array(${params.categoryIds ?? null}, ',')::bigint[]))
       AND (${params.feeTypes ?? null}::text IS NULL
            OR f.fee_type::text = ANY(string_to_array(${params.feeTypes ?? null}, ',')))
       AND (${params.isActive ?? null}::boolean IS NULL OR f.is_active = ${params.isActive ?? null}::boolean)
       /*
         Overlap, not containment. A price effective Jan–Dec is one an admin
         asking about March expects to see, so the row is kept when its window
         touches the asked-for window at all.
       */
       AND (${params.effectiveTo ?? null}::date IS NULL
            OR f.effective_from::date <= ${params.effectiveTo ?? null}::date)
       AND (${params.effectiveFrom ?? null}::date IS NULL
            OR f.effective_to IS NULL
            OR f.effective_to::date >= ${params.effectiveFrom ?? null}::date)
       AND (${params.createdFrom ?? null}::date IS NULL OR f."createdAt"::date >= ${params.createdFrom ?? null}::date)
       AND (${params.createdTo ?? null}::date IS NULL OR f."createdAt"::date <= ${params.createdTo ?? null}::date)
       AND (${params.activeOnly ?? false} = false OR f.is_active = true)
       AND (${search}::text IS NULL
            OR c.name ILIKE ${search}
            OR t.name ILIKE ${search}
            OR f.notes ILIKE ${search})
     ORDER BY c.display_order ASC, f.effective_from DESC, f.id DESC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export const findFeeById = (db: Db, id: bigint) =>
  db.feeStructure.findFirst({ where: { id, deletedAt: null } });

export const createFee = (db: Db, data: Prisma.FeeStructureUncheckedCreateInput) =>
  db.feeStructure.create({ data });

export const updateFee = (db: Db, id: bigint, data: Prisma.FeeStructureUpdateInput) =>
  db.feeStructure.update({ where: { id }, data });

/**
 * The resolver (billing-payment.md §2).
 *
 * A tier-specific price beats a category-wide one; among equals the newest
 * `effective_from` wins. `tier_id IS NULL` rows are the category-wide fallback, so
 * the ORDER BY puts a real tier match first and the NULL row second.
 *
 * This single query is what M4 approval, M5 invoicing and M6 renewal all price
 * against. It is deliberately not duplicated anywhere.
 */
export const resolveFee = async (
  db: Db,
  params: { categoryId: bigint; tierId?: bigint | null; feeType: FeeType; onDate: Date },
): Promise<FeeRow | null> => {
  const rows = await db.$queryRaw<FeeRow[]>`
    SELECT f.id,
           f.category_id,
           c.name AS category_name,
           f.tier_id,
           t.name AS tier_name,
           f.fee_type,
           f.amount,
           f.tax_rate,
           f.currency,
           f.duration_months,
           f.effective_from,
           f.effective_to,
           f.is_active,
           f.notes,
           1::bigint AS total
      FROM "FeeStructures" f
      LEFT JOIN "MembershipCategories" c ON c.id = f.category_id
      LEFT JOIN "MembershipTiers" t ON t.id = f.tier_id
     WHERE f."deletedAt" IS NULL
       AND f.is_active = true
       AND (f.category_id = ${params.categoryId} OR f.category_id IS NULL)
       AND f.fee_type::text = ${params.feeType}
       AND (f.tier_id IS NULL OR f.tier_id = ${params.tierId ?? null}::bigint)
       AND f.effective_from <= ${params.onDate}::date
       AND (f.effective_to IS NULL OR f.effective_to >= ${params.onDate}::date)
     ORDER BY f.category_id DESC NULLS LAST, (f.tier_id IS NULL) ASC, f.effective_from DESC
     LIMIT 1`;

  return rows[0] ?? null;
};

/* -------------------------------------------------------------------------- */
/* Company types                                                                */
/* -------------------------------------------------------------------------- */

export interface CompanyTypeRow {
  id: bigint;
  code: string;
  name: string;
  display_order: number;
  is_active: boolean;
  member_count: bigint;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listCompanyTypes = (
  db: Db,
  params: {
    search?: string | undefined;
    isActive?: boolean | undefined;
    limit: number;
    offset: number;
  },
): Promise<CompanyTypeRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const isActive = params.isActive ?? null;

  return db.$queryRaw<CompanyTypeRow[]>`
    SELECT ct.id,
           ct.code,
           ct.name,
           ct.display_order,
           ct.is_active,
           (SELECT count(*) FROM "Members" m
              WHERE m.company_type_id = ct.id AND m."deletedAt" IS NULL) AS member_count,
           ct."createdAt",
           ct."updatedAt",
           count(*) OVER () AS total
      FROM "CompanyTypes" ct
     WHERE ct."deletedAt" IS NULL
       AND (${search}::text IS NULL OR ct.name ILIKE ${search}::text OR ct.code ILIKE ${search}::text)
       AND (${isActive}::boolean IS NULL OR ct.is_active = ${isActive}::boolean)
     ORDER BY ct.display_order ASC, ct.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export const activeCompanyTypes = (db: Db) =>
  db.companyType.findMany({
    where: { deletedAt: null, is_active: true },
    select: { id: true, code: true, name: true, display_order: true },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
  });

/* -------------------------------------------------------------------------- */
/* Event types (M7)                                                            */
/* -------------------------------------------------------------------------- */

export interface EventTypeRow {
  id: bigint;
  code: string;
  name: string;
  display_order: number;
  is_active: boolean;
  event_count: bigint;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

/**
 * The list, with what each type is being used by.
 *
 * `event_count` is on the row rather than fetched per-row on the screen: it is
 * what decides whether a type can be deleted, and an admin who can see the
 * number never presses a delete that is going to be refused.
 */
export const listEventTypes = (
  db: Db,
  params: {
    search?: string | undefined;
    isActive?: boolean | undefined;
    limit: number;
    offset: number;
  },
): Promise<EventTypeRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const isActive = params.isActive ?? null;

  return db.$queryRaw<EventTypeRow[]>`
    SELECT et.id,
           et.code,
           et.name,
           et.display_order,
           et.is_active,
           (SELECT count(*) FROM "Events" e
              WHERE e.event_type_id = et.id AND e."deletedAt" IS NULL) AS event_count,
           et."createdAt",
           et."updatedAt",
           count(*) OVER () AS total
      FROM "EventTypes" et
     WHERE et."deletedAt" IS NULL
       AND (${search}::text IS NULL OR et.name ILIKE ${search}::text OR et.code ILIKE ${search}::text)
       AND (${isActive}::boolean IS NULL OR et.is_active = ${isActive}::boolean)
     ORDER BY et.display_order ASC, et.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

/** The ones the event form may still offer. Deactivated types are not here. */
export const activeEventTypes = (db: Db) =>
  db.eventType.findMany({
    where: { deletedAt: null, is_active: true },
    select: { id: true, code: true, name: true, display_order: true },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
  });

/* -------------------------------------------------------------------------- */
/* Countries, states, cities                                                    */
/* -------------------------------------------------------------------------- */

export interface CountryRow {
  id: bigint;
  iso_code: string;
  name: string;
  display_order: number;
  is_active: boolean;
  state_count: bigint;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listCountries = (
  db: Db,
  params: {
    search?: string | undefined;
    isActive?: boolean | undefined;
    limit: number;
    offset: number;
  },
): Promise<CountryRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const isActive = params.isActive ?? null;

  return db.$queryRaw<CountryRow[]>`
    SELECT c.id,
           c.iso_code,
           c.name,
           c.display_order,
           c.is_active,
           (SELECT count(*) FROM "States" s
              WHERE s.country_id = c.id AND s."deletedAt" IS NULL) AS state_count,
           c."createdAt",
           c."updatedAt",
           count(*) OVER () AS total
      FROM "Countries" c
     WHERE c."deletedAt" IS NULL
       AND (${search}::text IS NULL OR c.name ILIKE ${search}::text OR c.iso_code ILIKE ${search}::text)
       AND (${isActive}::boolean IS NULL OR c.is_active = ${isActive}::boolean)
     ORDER BY c.display_order ASC, c.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export interface StateRow {
  id: bigint;
  country_id: bigint;
  country_name: string;
  code: string;
  name: string;
  is_active: boolean;
  city_count: bigint;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listStates = (
  db: Db,
  params: {
    search?: string | undefined;
    isActive?: boolean | undefined;
    countryIds?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<StateRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const isActive = params.isActive ?? null;
  const countryIds = params.countryIds ?? null;

  return db.$queryRaw<StateRow[]>`
    SELECT s.id,
           s.country_id,
           co.name AS country_name,
           s.code,
           s.name,
           s.is_active,
           (SELECT count(*) FROM "Cities" ci
              WHERE ci.state_id = s.id AND ci."deletedAt" IS NULL) AS city_count,
           s."createdAt",
           s."updatedAt",
           count(*) OVER () AS total
      FROM "States" s
      JOIN "Countries" co ON co.id = s.country_id
     WHERE s."deletedAt" IS NULL
       AND (${search}::text IS NULL OR s.name ILIKE ${search}::text OR s.code ILIKE ${search}::text)
       AND (${isActive}::boolean IS NULL OR s.is_active = ${isActive}::boolean)
       AND (${countryIds}::text IS NULL
            OR s.country_id = ANY(string_to_array(${countryIds}::text, ',')::bigint[]))
     ORDER BY co.display_order ASC, s.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export interface CityRow {
  id: bigint;
  state_id: bigint;
  state_name: string;
  country_name: string;
  name: string;
  is_active: boolean;
  address_count: bigint;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listCities = (
  db: Db,
  params: {
    search?: string | undefined;
    isActive?: boolean | undefined;
    stateIds?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<CityRow[]> => {
  const search = params.search ? `%${params.search}%` : null;
  const isActive = params.isActive ?? null;
  const stateIds = params.stateIds ?? null;

  return db.$queryRaw<CityRow[]>`
    SELECT ci.id,
           ci.state_id,
           s.name  AS state_name,
           co.name AS country_name,
           ci.name,
           ci.is_active,
           (SELECT count(*) FROM "MemberAddresses" a
              WHERE a.city_id = ci.id AND a."deletedAt" IS NULL) AS address_count,
           ci."createdAt",
           ci."updatedAt",
           count(*) OVER () AS total
      FROM "Cities" ci
      JOIN "States"    s  ON s.id  = ci.state_id
      JOIN "Countries" co ON co.id = s.country_id
     WHERE ci."deletedAt" IS NULL
       AND (${search}::text IS NULL OR ci.name ILIKE ${search}::text)
       AND (${isActive}::boolean IS NULL OR ci.is_active = ${isActive}::boolean)
       AND (${stateIds}::text IS NULL
            OR ci.state_id = ANY(string_to_array(${stateIds}::text, ',')::bigint[]))
     ORDER BY s.name ASC, ci.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export const activeCountries = (db: Db) =>
  db.country.findMany({
    where: { deletedAt: null, is_active: true },
    select: { id: true, iso_code: true, name: true },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
  });

export const activeStates = (db: Db, countryId: bigint) =>
  db.state.findMany({
    where: { deletedAt: null, is_active: true, country_id: countryId },
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });

export const activeCities = (db: Db, stateId: bigint) =>
  db.city.findMany({
    where: { deletedAt: null, is_active: true, state_id: stateId },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

/* -------------------------------------------------------------------------- */
/* Document types                                                              */
/* -------------------------------------------------------------------------- */

export interface DocumentTypeRow {
  id: bigint;
  code: string;
  name: string;
  description: string | null;
  applies_to: DocumentAppliesTo;
  is_required: boolean;
  sides: DocumentSides;
  max_size_mb: number;
  allowed_mime: string[];
  display_order: number;
  is_active: boolean;
  createdAt: Date;
  updatedAt: Date;
  total: bigint;
}

export const listDocumentTypes = (
  db: Db,
  params: {
    appliesTo?: string | undefined;
    sides?: string | undefined;
    isActive?: boolean | undefined;
    createdFrom?: string | undefined;
    createdTo?: string | undefined;
    search?: string | undefined;
    activeOnly?: boolean | undefined;
    limit: number;
    offset: number;
  },
): Promise<DocumentTypeRow[]> => {
  const search = params.search ? `%${params.search}%` : null;

  return db.$queryRaw<DocumentTypeRow[]>`
    SELECT d.id,
           d.code,
           d.name,
           d.description,
           d.applies_to,
           d.is_required,
           d.sides,
           d.max_size_mb,
           d.allowed_mime,
           d.display_order,
           d.is_active,
           d."createdAt",
           d."updatedAt",
           count(*) OVER () AS total
      FROM "DocumentTypes" d
     WHERE d."deletedAt" IS NULL
       -- BOTH matches either side, which is why this is not a plain equality.
       /*
         A type marked BOTH answers every audience, so it survives any filter —
         that rule predates the multi-select and is kept exactly as it was.
       */
       AND (${params.appliesTo ?? null}::text IS NULL
            OR d.applies_to::text = ANY(string_to_array(${params.appliesTo ?? null}, ','))
            OR d.applies_to::text = 'BOTH')
       -- No BOTH-style escape hatch here: a type is one shape or the other.
       AND (${params.sides ?? null}::text IS NULL
            OR d.sides::text = ANY(string_to_array(${params.sides ?? null}, ',')))
       AND (${params.isActive ?? null}::boolean IS NULL OR d.is_active = ${params.isActive ?? null}::boolean)
       AND (${params.createdFrom ?? null}::date IS NULL OR d."createdAt"::date >= ${params.createdFrom ?? null}::date)
       AND (${params.createdTo ?? null}::date IS NULL OR d."createdAt"::date <= ${params.createdTo ?? null}::date)
       AND (${params.activeOnly ?? false} = false OR d.is_active = true)
       AND (${search}::text IS NULL OR d.name ILIKE ${search} OR d.code ILIKE ${search})
     ORDER BY d.display_order ASC, d.name ASC
     LIMIT ${params.limit} OFFSET ${params.offset}`;
};

export const findDocumentTypeById = (db: Db, id: bigint) =>
  db.documentType.findFirst({ where: { id, deletedAt: null } });

export const findDocumentTypeByCode = (db: Db, code: string) =>
  db.documentType.findFirst({ where: { code, deletedAt: null } });

export const createDocumentType = (db: Db, data: Prisma.DocumentTypeCreateInput) =>
  db.documentType.create({ data });

export const updateDocumentType = (db: Db, id: bigint, data: Prisma.DocumentTypeUpdateInput) =>
  db.documentType.update({ where: { id }, data });

/**
 * How many live files point at this document type, across both checklists.
 *
 * Soft-deleted files do not count — a removed upload is not a reason to keep a
 * type on the books. Soft-deleted *types* are irrelevant here; the caller has
 * already established the type exists.
 */
export const countDocumentTypeUsage = async (db: Db, id: bigint): Promise<number> => {
  const [applications, members] = await Promise.all([
    db.applicationDocument.count({ where: { document_type_id: id, deletedAt: null } }),
    db.memberDocument.count({ where: { document_type_id: id, deletedAt: null } }),
  ]);

  return applications + members;
};
