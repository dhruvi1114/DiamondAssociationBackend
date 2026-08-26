import { AddressType, MemberStatus } from '@prisma/client';
import { z } from 'zod';

/**
 * Request schemas for the member record (M3).
 *
 * The split that matters is §A-11: a member edits contact details directly, but
 * the fields that identify the company to the federation — legal name, IEC, GST,
 * PAN, trade licence — go through an approver. Changing those silently would
 * change who the membership belongs to.
 */

/** Editable by the member, immediately. */
/**
 * A repeated filter arrives as `?status=A,B`. Split, trim and drop blanks, so a
 * trailing comma or an empty selection is an absent filter rather than a 422.
 */
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(item).nonempty().optional());

export const SELF_EDITABLE_FIELDS = ['company_name', 'website', 'about'] as const;

/** Editable only through an approved change request. */
export const APPROVAL_REQUIRED_FIELDS = [
  'legal_name',
  'iec_code',
  'gst_number',
  'pan_number',
  'trade_license_no',
] as const;

const trimmed = (max: number) => z.string().trim().max(max, 'validation.tooLong');

/** GSTIN: 2-digit state, 5 letters, 4 digits, letter, digit/letter, Z, checksum. */
const gst = z
  .string()
  .trim()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'validation.invalidGst');

/** PAN: 5 letters, 4 digits, 1 letter. */
const pan = z
  .string()
  .trim()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'validation.invalidPan');

/** IEC: 10 alphanumeric characters. */
const iec = z
  .string()
  .trim()
  .regex(/^[0-9A-Z]{10}$/, 'validation.invalidIec');

export const updateProfileSchema = z.object({
  company_name: trimmed(200).min(1, 'validation.requiredFields').optional(),
  website: trimmed(200).url('member.invalidWebsite').nullish(),
  about: trimmed(2000).nullish(),
  /** Replaces the member's full set of category claims when provided. */
  category_ids: z.array(z.string().regex(/^\d+$/, 'validation.invalidId')).max(20).optional(),
  directory_visible: z.boolean().optional(),
});

/**
 * A change request carries only the approval-gated fields. Anything self-editable
 * that arrives here is rejected rather than quietly ignored — a member who thinks
 * they queued a phone-number change should be told it saved instantly instead.
 */
export const createChangeRequestSchema = z
  .object({
    legal_name: trimmed(200).nullish(),
    iec_code: iec.nullish(),
    gst_number: gst.nullish(),
    pan_number: pan.nullish(),
    trade_license_no: trimmed(50).nullish(),
    reason: trimmed(1000).optional(),
  })
  .refine(
    (value) =>
      APPROVAL_REQUIRED_FIELDS.some((field) => value[field as keyof typeof value] !== undefined),
    { message: 'member.changeRequestEmpty' },
  );

export const contactSchema = z.object({
  name: trimmed(150).min(1, 'validation.requiredFields'),
  designation: trimmed(100).nullish(),
  email: z.string().trim().email('validation.invalidEmail').nullish(),
  phone: z
    .string()
    .trim()
    .regex(/^[+]?[0-9\s-]{7,20}$/, 'validation.invalidPhone')
    .nullish(),
  is_primary: z.boolean().default(false),
});

export const addressSchema = z.object({
  address_type: z.nativeEnum(AddressType).default(AddressType.REGISTERED),
  line1: trimmed(200).min(1, 'validation.requiredFields'),
  line2: trimmed(200).nullish(),
  city: trimmed(100).min(1, 'validation.requiredFields'),
  state: trimmed(100).min(1, 'validation.requiredFields'),
  country: trimmed(100).default('India'),
  pincode: z
    .string()
    .trim()
    .regex(/^[0-9]{4,10}$/, 'member.invalidPincode'),
  is_primary: z.boolean().default(false),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

export const invoicePaymentParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  invoiceId: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

/** Columns an admin may sort the member list by. Anything else is a 422 — an
 *  un-allowlisted column reaching ORDER BY is how a sort parameter becomes an
 *  injection point (api-conventions.md §6). */
export const MEMBER_SORT_COLUMNS = ['company_name', 'member_code', 'status', 'createdAt'] as const;

export const listMembersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((value) => Math.min(value, 100)),
  search: trimmed(150).min(1).optional(),
  status: csv(z.nativeEnum(MemberStatus)),
  category_id: csv(z.string().regex(/^\d+$/, 'validation.invalidId')),
  tier_id: z.string().regex(/^\d+$/, 'validation.invalidId').optional(),
  sortBy: z.enum(MEMBER_SORT_COLUMNS).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const adminUpdateMemberSchema = z.object({
  company_name: trimmed(200).min(1).optional(),
  legal_name: trimmed(200).nullish(),
  business_type: trimmed(100).nullish(),
  iec_code: iec.nullish(),
  gst_number: gst.nullish(),
  pan_number: pan.nullish(),
  trade_license_no: trimmed(50).nullish(),
  website: trimmed(200).url('member.invalidWebsite').nullish(),
  about: trimmed(2000).nullish(),
  directory_visible: z.boolean().optional(),
});

export const changeCategorySchema = z.object({
  category_ids: z
    .array(z.string().regex(/^\d+$/, 'validation.invalidId'))
    .min(1, 'validation.requiredFields')
    .max(20),
  reason: trimmed(1000).min(1, 'member.reasonRequired'),
});

/**
 * Suspend, reactivate and terminate all demand a reason. The member is told what
 * happened and why; "status changed" with no explanation is the thing that
 * generates the support call this platform exists to prevent.
 */
export const statusChangeSchema = z.object({
  reason: trimmed(1000).min(1, 'member.reasonRequired'),
});

export const decideChangeRequestSchema = z.object({
  remarks: trimmed(1000).optional(),
});

export const rejectChangeRequestSchema = z.object({
  remarks: trimmed(1000).min(1, 'member.remarksRequired'),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type ContactInput = z.infer<typeof contactSchema>;
export type AddressInput = z.infer<typeof addressSchema>;
export type ListMembersQuery = z.infer<typeof listMembersSchema>;
export type AdminUpdateMemberInput = z.infer<typeof adminUpdateMemberSchema>;
export type ChangeCategoryInput = z.infer<typeof changeCategorySchema>;
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;
