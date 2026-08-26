import { ApplicationStatus } from '@prisma/client';
import { z } from 'zod';

/**
 * Request schemas for applications and approval decisions (M4).
 *
 * The applicant's schema is deliberately permissive while the application is a
 * DRAFT — a half-filled form must be savable, or people lose work. Completeness
 * is checked once, at submission, where the message can name exactly what is
 * missing.
 */

const trimmed = (max: number) => z.string().trim().max(max, 'validation.tooLong');

const gst = z
  .string()
  .trim()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'validation.invalidGst');
const pan = z
  .string()
  .trim()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'validation.invalidPan');
const iec = z
  .string()
  .trim()
  .regex(/^[0-9A-Z]{10}$/, 'validation.invalidIec');

/** Everything the applicant fills in. All optional: a draft is saved as it grows. */
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

export const saveDraftSchema = z.object({
  category_id: z.string().regex(/^\d+$/, 'validation.invalidId').optional(),
  tier_id: z.string().regex(/^\d+$/, 'validation.invalidId').nullish(),
  company_name: trimmed(200).min(1, 'validation.requiredFields').optional(),
  legal_name: trimmed(200).nullish(),
  business_type: trimmed(100).nullish(),
  iec_code: iec.nullish(),
  gst_number: gst.nullish(),
  pan_number: pan.nullish(),
  trade_license_no: trimmed(50).nullish(),
  website: trimmed(200).url('member.invalidWebsite').nullish(),
  about: trimmed(2000).nullish(),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

/**
 * For the `/:id/documents/:documentId/…` routes.
 *
 * `validateRequest` REPLACES `req.params` with the parsed object, and zod strips
 * keys the schema does not mention — so validating these routes with
 * `idParamSchema` silently deleted `documentId` and the handler read `undefined`.
 * Any schema used on a route must name every parameter that route carries.
 */
export const documentIdParamSchema = idParamSchema.extend({
  documentId: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

/* -------------------------------------------------------------------------- */
/* Reviewer decisions                                                          */
/* -------------------------------------------------------------------------- */

/** Approving needs no words; the next stage or the activation speaks for it. */
export const approveSchema = z.object({
  remarks: trimmed(2000).optional(),
});

/**
 * Rejecting demands remarks, mirroring the database CHECK. The constraint is the
 * guarantee; this is the message the reviewer can act on, pointed at the field
 * they must fill.
 *
 * `documents` carries the per-document ✗ marks the reviewer made in the panel
 * before pressing the one button (spec D-6, D-8). Optional, because a rejection
 * can be about the form rather than the files — an application whose documents
 * are all fine but whose GSTIN does not match the trading name is rejected with
 * an empty array and a note.
 *
 * Nothing here re-decides a document: the ids name marks the reviewer has
 * already made, and the service verifies each one belongs to this application
 * before touching it.
 */
export const rejectSchema = z.object({
  remarks: trimmed(2000).min(1, 'application.remarksRequired'),
  documents: z
    .array(
      z.object({
        id: z.string().regex(/^\d+$/, 'validation.invalidId'),
        remarks: trimmed(2000).min(1, 'application.documentRemarksRequired'),
      }),
    )
    .max(20)
    .optional(),
});

export const reassignSchema = z.object({
  stage_id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  remarks: trimmed(2000).min(1, 'application.remarksRequired'),
});

/** Columns an admin may sort the queue by — allowlisted, never interpolated raw. */
export const APPLICATION_SORT_COLUMNS = [
  'submitted_at',
  'company_name',
  'status',
  'createdAt',
] as const;

/** `YYYY-MM-DD`, as a date filter arrives on the query string. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
  .optional();

export const listApplicationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((value) => Math.min(value, 100)),
  search: trimmed(150).min(1).optional(),
  status: csv(z.nativeEnum(ApplicationStatus)),
  stage_id: csv(z.string().regex(/^\d+$/, 'validation.invalidId')),
  category_id: csv(z.string().regex(/^\d+$/, 'validation.invalidId')),
  /**
   * `true` narrows the queue to stages the caller's own roles own — the default
   * view for a reviewer, who wants their work rather than everyone's.
   */
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  /**
   * Submitted-date window, inclusive at both ends, `YYYY-MM-DD`.
   *
   * The submitted date, not the created one: a draft is not in this list at all,
   * and "how many came in last week" is the question the queue is asked. It is
   * also the column the list sorts by out of the box.
   */
  submitted_from: dateOnly,
  submitted_to: dateOnly,
  /**
   * Primary-address city / state, by NAME, comma-separated like every other
   * list filter here. Names rather than master ids because the id columns on
   * `MemberAddresses` are nullable while the text ones are not — see the note
   * on `listApplications`.
   */
  city: csv(trimmed(100).min(1)),
  state: csv(trimmed(100).min(1)),
  /** Narrows to applications carrying at least one PENDING document — the Verification tab. */
  has_pending_documents: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  sortBy: z.enum(APPLICATION_SORT_COLUMNS).default('submitted_at'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
});

export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
export type ApproveInput = z.infer<typeof approveSchema>;
export type RejectInput = z.infer<typeof rejectSchema>;
export type ReassignInput = z.infer<typeof reassignSchema>;
export type ListApplicationsQuery = z.infer<typeof listApplicationsSchema>;
