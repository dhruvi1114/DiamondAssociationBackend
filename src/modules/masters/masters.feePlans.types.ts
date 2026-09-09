import { z } from 'zod';

/**
 * Request shapes for the redesigned price list (M2 redesign).
 * Spec: `docs/specs/2026-09-07-membership-fee-plans.md`.
 */

const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'validation.invalidAmount')
  .describe('Decimal as a string — never a float (ADR-007).');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate');

export const billingCycleEnum = z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY']);

export const priceScopeEnum = z.enum(['ALL_MEMBERS', 'NEW_MEMBERS_ONLY']);

/**
 * One cycle's intended state. Both prices are required, which is the rule the whole redesign
 * exists to impose: the shape this replaces let a joining price be published with no renewal
 * price behind it, and the live data proves what that leads to.
 */
export const feePlanInputSchema = z.object({
  billing_cycle: billingCycleEnum,
  name: z.string().trim().min(1, 'validation.required').max(120),
  amount: money,
  renewal_amount: money,
  tax_rate: money.default('0'),
});

export const createStructureSchema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(120),
  effective_from: isoDate,
  /*
    Who the new prices reach, when members are already sitting on a retired price for one of
    these cycles.

    On CREATE, not only on update, because decision D-3 makes retire-then-create the normal way a
    price changes: a live structure blocks a new one, so an admin closes the old list and
    publishes its replacement. Without this the answer had nowhere to go and the service defaulted
    to ALL_MEMBERS — which silently moved the very members an admin had chosen to freeze.
  */
  price_scope: priceScopeEnum.optional(),
  /*
    At least one. A structure with no live plan shows nothing on the website and cannot be
    applied for, so publishing one is always a mistake rather than a choice (spec R-4).
  */
  plans: z.array(feePlanInputSchema).min(1, 'masters.feePlanAtLeastOne'),
});

/**
 * The same body, plus the scope answer.
 *
 * A structure is saved WHOLE, not plan by plan (spec D-6): the server sees every cycle's
 * intended state in one request and settles the lot in one transaction. Four separate PATCHes
 * would let a closed browser tab leave a price list half-changed, and a half-changed price list
 * is the one state nothing downstream can price against.
 */
export const updateStructureSchema = createStructureSchema;

export const setStructureActiveSchema = z.object({
  is_active: z.boolean(),
});

export const structureListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().optional(),
  /** Comma-separated — the control is a MultiSelect. */
  status: z.string().trim().optional(),
  /**
   * Inclusive window on when the list was published, `YYYY-MM-DD`. Either end
   * may stand alone: "everything since March" and "everything before March" are
   * both questions somebody asks, and neither needs the other bound.
   */
  created_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
    .optional(),
  created_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
    .optional(),
  /**
   * Inclusive window on when a list's prices START applying, `YYYY-MM-DD`.
   *
   * Matched against the plans, not the structure: the effective date belongs to
   * a price, and a list is "effective in March" when any price in it is.
   */
  effective_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
    .optional(),
  effective_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
    .optional(),
});

export const structureIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

export type FeePlanInput = z.infer<typeof feePlanInputSchema>;
export type CreateStructureInput = z.infer<typeof createStructureSchema>;
export type UpdateStructureInput = z.infer<typeof updateStructureSchema>;
export type SetStructureActiveInput = z.infer<typeof setStructureActiveSchema>;
export type StructureListQuery = z.infer<typeof structureListQuerySchema>;
