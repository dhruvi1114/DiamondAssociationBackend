import { DocumentAppliesTo, DocumentSides, FeeType } from '@prisma/client';
import { z } from 'zod';

/**
 * Request schemas for the membership catalogue (M2): categories, tiers, fees and
 * document types.
 *
 * Every message is an i18n key, never a sentence — the resolved string depends on
 * the `lan` header (architecture.md §6).
 *
 * Amounts arrive as strings. A JSON number for money is a float by the time it
 * reaches us, and `25000.10` does not survive that round trip intact (ADR-007).
 */

const code = z
  .string({ required_error: 'validation.requiredFields' })
  .trim()
  .min(1, 'validation.requiredFields')
  .max(30, 'validation.tooLong')
  // Machine name, not display text: it ends up in seeds, imports and the fee
  // resolver, so it may not carry spaces or case that a later import would guess at.
  .regex(/^[A-Z][A-Z0-9_]*$/, 'masters.invalidCode');

const name = z
  .string({ required_error: 'validation.requiredFields' })
  .trim()
  .min(1, 'validation.requiredFields')
  .max(120, 'validation.tooLong');

/**
 * Free-text guidance. Absent, null and empty all mean "none".
 *
 * `.nullish()` rather than `.optional()` because the column is nullable and the
 * admin drawer round-trips the row it loaded: editing a type that has no guidance
 * sent `description: null` straight back and was refused with "please correct the
 * highlighted fields", naming a field the admin had not touched.
 *
 * The transform collapses `''` to null too, so clearing the box blanks the
 * guidance instead of storing an empty string that reads as blank but is not.
 */
const description = z
  .string()
  .trim()
  .max(2000, 'validation.tooLong')
  .nullish()
  .transform((value) => value || null);

/** Money on the wire: a 2-decimal string, validated before it becomes a Decimal. */
const money = z
  .string({ required_error: 'validation.requiredFields' })
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'masters.invalidAmount');

const percent = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'masters.invalidTaxRate')
  .refine((value) => Number(value) <= 100, 'masters.invalidTaxRate')
  .optional();

/** `YYYY-MM-DD`. Dates here are calendar dates, not instants — a price starts on a day. */
const isoDate = z
  .string({ required_error: 'validation.requiredFields' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'masters.invalidDate');

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Clamped, never rejected (api-conventions.md §6).
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((value) => Math.min(value, 100)),
  search: z.string().trim().min(1).max(150).optional(),
  /** `true` hides deactivated rows; omitted returns both, which is what an admin editing masters wants. */
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

/* --- filter fragments, shared by every masters list ----------------------- */

/**
 * A comma-separated list of ids, e.g. `3` or `3,7,11`.
 *
 * Validated whole rather than split later: `category_id=3,banana` has to be a
 * 422. A schema that took `z.string()` and split downstream would drop the bad
 * half in silence, which is the failure mode that makes a filter look broken
 * rather than rejected.
 */
const idCsv = z
  .string()
  .regex(/^\d+(,\d+)*$/, 'validation.invalidId')
  .optional();

/** A comma-separated list drawn from a fixed set of codes. */
const enumCsv = (values: readonly string[]) => {
  const one = `(${values.join('|')})`;

  return z
    .string()
    .regex(new RegExp(`^${one}(,${one})*$`), 'validation.invalidFilter')
    .optional();
};

/**
 * Live / switched off, as a multi-select.
 *
 * NOT the same thing as `activeOnly`, which can only ever hide deactivated rows.
 * An admin auditing what has been switched off needs the opposite, so this is
 * its own tri-state param and both survive side by side.
 */
const statusCsv = enumCsv(['active', 'inactive']);

/** Plain `YYYY-MM-DD`. The repositories cast to `::date` at both ends. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
  .optional();

/**
 * The category list's own filters, on top of the shared paging/search.
 *
 * A separate schema rather than fields on `listQuerySchema`: that one is
 * extended by tiers and read by the public endpoint, and a filter that only the
 * admin category screen sends has no business widening either of them.
 *
 * `status` is tri-state on purpose and is NOT the same thing as `activeOnly`.
 * `activeOnly` answers "hide the deactivated rows" and cannot ask the opposite;
 * an admin auditing what has been switched off needs exactly that opposite, so
 * omitted means both, `active` means live, `inactive` means switched off.
 */
export const categoryListQuerySchema = listQuerySchema.extend({
  status: statusCsv,
  created_from: dateOnly,
  created_to: dateOnly,
});

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

export const createCategorySchema = z.object({
  code,
  name,
  description,
  display_order: z.coerce.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
});

/** `code` is absent on purpose: renaming a machine name orphans every reference to it. */
export const updateCategorySchema = createCategorySchema.omit({ code: true }).partial();

/* -------------------------------------------------------------------------- */
/* Tiers                                                                       */
/* -------------------------------------------------------------------------- */

export const createTierSchema = z.object({
  category_id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  code,
  name,
  description,
  display_order: z.coerce.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
});

/** Neither `code` nor `category_id` may change — a tier cannot migrate between categories. */
export const updateTierSchema = createTierSchema.omit({ code: true, category_id: true }).partial();

export const tierListQuerySchema = listQuerySchema.extend({
  // Widened from a single id to a list. A bare `3` still matches the pattern,
  // so every existing caller keeps working.
  category_id: idCsv,
  status: statusCsv,
  created_from: dateOnly,
  created_to: dateOnly,
});

/* -------------------------------------------------------------------------- */
/* Fees                                                                        */
/* -------------------------------------------------------------------------- */

export const createFeeSchema = z
  .object({
    /** Omit for the association-wide flat price (spec D-7). */
    category_id: z.string().regex(/^\d+$/, 'validation.invalidId').nullish(),
    /** Omit for a price that covers the whole category — unused while tiers are parked. */
    tier_id: z.string().regex(/^\d+$/, 'validation.invalidId').nullish(),
    fee_type: z.nativeEnum(FeeType),
    amount: money,
    tax_rate: percent,
    duration_months: z.coerce.number().int().min(1).max(120).default(12),
    effective_from: isoDate,
    effective_to: isoDate.nullish(),
    is_active: z.boolean().default(true),
    notes: description,
  })
  .refine((value) => !value.effective_to || value.effective_to > value.effective_from, {
    message: 'masters.effectiveRangeInvalid',
    path: ['effective_to'],
  });

/**
 * A price that has already billed someone is history, so the editable surface is
 * deliberately narrow: close it with an `effective_to`, deactivate it, or annotate
 * it. Changing an amount creates a new row instead (billing-payment.md §2).
 */
export const updateFeeSchema = z.object({
  effective_to: isoDate.nullish(),
  is_active: z.boolean().optional(),
  notes: description,
});

export const feeListQuerySchema = listQuerySchema.extend({
  category_id: idCsv,
  fee_type: enumCsv(Object.values(FeeType)),
  status: statusCsv,
  // The window the price applies IN, which is the question an admin actually
  // asks of a price list — distinct from when the row was typed in.
  effective_from: dateOnly,
  effective_to: dateOnly,
  created_from: dateOnly,
  created_to: dateOnly,
});

/** Query for the resolver preview — "what would we charge for this, today?" */
export const resolveFeeQuerySchema = z.object({
  category_id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  tier_id: z.string().regex(/^\d+$/, 'validation.invalidId').optional(),
  fee_type: z.nativeEnum(FeeType),
  on_date: isoDate.optional(),
});

/* -------------------------------------------------------------------------- */
/* Document types                                                              */
/* -------------------------------------------------------------------------- */

const MIME_ALLOWLIST = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;

export const createDocumentTypeSchema = z.object({
  code: code.max(50),
  name,
  description,
  applies_to: z.nativeEnum(DocumentAppliesTo).default(DocumentAppliesTo.BOTH),
  is_required: z.boolean().default(false),
  /**
   * One file, or a front and a back. Defaults to SINGLE so every type created
   * before M5 — and every type created without thinking about it — behaves the
   * way the checklist always has.
   */
  sides: z.nativeEnum(DocumentSides).default(DocumentSides.SINGLE),
  max_size_mb: z.coerce.number().int().min(1).max(50).default(10),
  /**
   * Constrained to types we can actually sniff and safely hand back to a browser.
   * An admin cannot add `image/svg+xml` here: SVG executes script, and these files
   * are opened by staff reviewing KYC (file-storage.md §3).
   */
  allowed_mime: z
    .array(z.enum(MIME_ALLOWLIST))
    .min(1, 'masters.mimeRequired')
    .default(['application/pdf', 'image/jpeg', 'image/png']),
  display_order: z.coerce.number().int().min(0).max(999).default(0),
  is_active: z.boolean().default(true),
});

export const updateDocumentTypeSchema = createDocumentTypeSchema.omit({ code: true }).partial();

export const documentTypeListQuerySchema = listQuerySchema.extend({
  applies_to: enumCsv(Object.values(DocumentAppliesTo)),
  sides: enumCsv(Object.values(DocumentSides)),
  status: statusCsv,
  created_from: dateOnly,
  created_to: dateOnly,
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateTierInput = z.infer<typeof createTierSchema>;
export type UpdateTierInput = z.infer<typeof updateTierSchema>;
export type CreateFeeInput = z.infer<typeof createFeeSchema>;
export type UpdateFeeInput = z.infer<typeof updateFeeSchema>;
export type CreateDocumentTypeInput = z.infer<typeof createDocumentTypeSchema>;
export type UpdateDocumentTypeInput = z.infer<typeof updateDocumentTypeSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type TierListQuery = z.infer<typeof tierListQuerySchema>;
export type FeeListQuery = z.infer<typeof feeListQuerySchema>;
export type DocumentTypeListQuery = z.infer<typeof documentTypeListQuerySchema>;
export type ResolveFeeQuery = z.infer<typeof resolveFeeQuerySchema>;

/* -------------------------------------------------------------------------- */
/* M5 — registration masters                                                    */
/* -------------------------------------------------------------------------- */

const referenceId = z
  .string({ required_error: 'validation.requiredFields' })
  .regex(/^\d+$/, 'validation.invalidId');

export const createCompanyTypeSchema = z.object({
  code,
  name,
  display_order: z.coerce.number().int().min(0).max(9999).optional(),
  is_active: z.boolean().optional(),
});

export const updateCompanyTypeSchema = z
  .object({
    name: name.optional(),
    display_order: z.coerce.number().int().min(0).max(9999).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'validation.requiredFields');

export const createCountrySchema = z.object({
  iso_code: z
    .string({ required_error: 'validation.requiredFields' })
    .trim()
    .length(2, 'masters.invalidCode')
    .regex(/^[A-Z]{2}$/, 'masters.invalidCode'),
  name: z.string({ required_error: 'validation.requiredFields' }).trim().min(1).max(100),
  display_order: z.coerce.number().int().min(0).max(9999).optional(),
  is_active: z.boolean().optional(),
});

export const updateCountrySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    display_order: z.coerce.number().int().min(0).max(9999).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'validation.requiredFields');

export const createStateSchema = z.object({
  country_id: referenceId,
  code: z
    .string({ required_error: 'validation.requiredFields' })
    .trim()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9]+$/, 'masters.invalidCode'),
  name: z.string({ required_error: 'validation.requiredFields' }).trim().min(1).max(100),
  is_active: z.boolean().optional(),
});

export const updateStateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'validation.requiredFields');

export const stateListQuerySchema = listQuerySchema.extend({
  country_id: idCsv,
  status: statusCsv,
});

export const createCitySchema = z.object({
  state_id: referenceId,
  name: z.string({ required_error: 'validation.requiredFields' }).trim().min(1).max(100),
  is_active: z.boolean().optional(),
});

export const updateCitySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'validation.requiredFields');

export const cityListQuerySchema = listQuerySchema.extend({
  state_id: idCsv,
  status: statusCsv,
});

export const companyTypeListQuerySchema = listQuerySchema.extend({
  status: statusCsv,
});

export const countryListQuerySchema = listQuerySchema.extend({
  status: statusCsv,
});

export const publicStatesQuerySchema = z.object({ country_id: referenceId });
export const publicCitiesQuerySchema = z.object({ state_id: referenceId });

export type CreateCompanyTypeInput = z.infer<typeof createCompanyTypeSchema>;
export type UpdateCompanyTypeInput = z.infer<typeof updateCompanyTypeSchema>;
export type CreateCountryInput = z.infer<typeof createCountrySchema>;
export type UpdateCountryInput = z.infer<typeof updateCountrySchema>;
export type CreateStateInput = z.infer<typeof createStateSchema>;
export type UpdateStateInput = z.infer<typeof updateStateSchema>;
export type CreateCityInput = z.infer<typeof createCitySchema>;
export type UpdateCityInput = z.infer<typeof updateCitySchema>;
export type CompanyTypeListQuery = z.infer<typeof companyTypeListQuerySchema>;
export type CountryListQuery = z.infer<typeof countryListQuerySchema>;
export type StateListQuery = z.infer<typeof stateListQuerySchema>;
export type CityListQuery = z.infer<typeof cityListQuerySchema>;
