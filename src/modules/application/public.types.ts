import { z } from 'zod';
import {
  applicationSnapshotFields,
  gstinHolderNeedsNumber,
  registrationFields,
} from '@modules/auth/register.schema';

/**
 * Request schemas for the login-free resubmit surface (spec §6 items 6, 10).
 *
 * Kept apart from `application.types.ts` because the two describe different
 * trust levels. Everything in that file is reached with a session behind it;
 * everything here is reached by anyone holding a URL, so the schemas are the
 * outermost thing standing between the public internet and an application row.
 *
 * `register.schema.ts` is the one file it does share with, and the sharing is
 * the point rather than a shortcut. Since D-16 this endpoint accepts the whole
 * registration form, so a GSTIN, PAN, pincode or phone that registration accepts
 * and this refuses — or the reverse — is a bug either way round: the applicant
 * would be handed back a form pre-filled with a value it will not let them save.
 * One definition of each expression is what keeps the two in step.
 */

const trimmed = (max: number) => z.string().trim().max(max, 'validation.tooLong');

/* -------------------------------------------------------------------------- */
/* What a correcting applicant may change                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every field the registration form collects, minus identity and consent (D-16).
 *
 * The first pass inferred a subset from the flagged documents — a ✗ on the PAN
 * document opened `pan_number` and `company_name`, and nothing else opened
 * anything — and the second pass widened that to the four columns the
 * application snapshot happened to carry. Neither was the form. The correction
 * page IS the registration form, pre-filled and re-worded, so anything the
 * applicant could type on the way in they can retype on the way back:
 *
 *  - **A subset had a dead end.** A rejection whose note said "the trading name
 *    does not match your licence" but flagged no document opened no fields at
 *    all. The applicant was told to correct something and handed a form that
 *    accepted nothing — the exact failure this whole flow exists to remove.
 *  - **The mapping was invented, not recorded.** There is no per-field flag in
 *    the schema; `requires_reupload` lives on documents. So "what the reviewer
 *    flagged" was being read out of a lookup table in this file rather than out
 *    of a decision anyone made. A guess dressed as a rule.
 *  - **Four columns is not the form.** A wrong pincode, a mistyped mobile or the
 *    wrong company type were unfixable, and those are ordinary registration
 *    typos — the reviewer would have had to reject an application nobody could
 *    then correct.
 *
 * What replaces it is what GJEPC and the GST portal already do: the reviewer's
 * note says what is wrong in words, and the applicant may fix anything on the
 * form. Documents stay flag-gated — a `VERIFIED` file is not asked for again
 * (D-12) — because that IS recorded, on the document row.
 *
 * Three things the registration form collects are deliberately absent, and each
 * is refused by name rather than quietly dropped (see `correctApplicationSchema`):
 *
 *  - **`email`.** It identifies the account this token belongs to. Accepting a
 *    new address would not correct an application, it would move it to a
 *    different person — on an endpoint whose entire authority is a URL somebody
 *    forwarded. A genuinely wrong address is a job for the association.
 *  - **`consent_accepted`.** `Members.consent_accepted_at` and `consent_ip` are
 *    the legal record of a consent already given. Re-collecting it would either
 *    overwrite that record with a later timestamp and a different IP, or write a
 *    second one — both of which make the evidence worse, not better.
 *  - **`captcha_token` / `captcha_answer`.** A captcha proves a human filled a
 *    form once; the correction link is already a per-application secret and is
 *    throttled by `rateLimiters.resubmitLink`. Asking again would gate a
 *    correction on a puzzle without adding a check.
 *
 * `iec_code` is absent for a different reason: the column exists on both the
 * snapshot and `Members`, where it is unique across live rows, but the
 * registration form does not collect it and nothing has said whether an
 * applicant may claim one unreviewed. Adding it needs the D-17 collision check
 * as well as the field, so it waits for someone to ask. Documented, not guessed.
 *
 * The list stays a whitelist rather than "every column": membership category,
 * tier, member code and the approval columns are not the applicant's to touch,
 * and an allowlist on an unauthenticated write path is worth keeping even when
 * it currently names every field the form shows.
 */
export const CORRECTABLE_FIELDS = [
  // --- the registration form, in the order it asks ---
  'pan_number',
  'gstin_holder',
  'gst_number',
  'company_category',
  'company_name',
  'company_type_id',
  'address_line1',
  'address_line2',
  'pincode',
  'country_id',
  'state_id',
  'city_id',
  'landline',
  'mobile',
  'category_ids',
  // --- snapshot columns the form does not ask for yet ---
  'legal_name',
  'business_type',
  'trade_license_no',
  'website',
  'about',
] as const;

export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/**
 * What the GET hands back for each field, keyed exactly as the form posts it.
 *
 * Ids are STRINGS, not numbers: they are `BigInt` in the database and every
 * select on the registration form already binds string values, so anything else
 * would force the client to convert on the way in and back on the way out. Ids
 * that were never set come back `null` rather than `""` — "no city recorded" and
 * "a city recorded as empty" are different facts and the form renders them
 * differently.
 *
 * `email` is present and is NOT in `CORRECTABLE_FIELDS`. The form has to render
 * the address the application belongs to — showing an applicant a blank email
 * box on a page about their own application is worse than useless — and
 * `editable_fields` is what tells the client to render it read-only.
 */
export interface CorrectableFieldValues {
  /** Read-only. Identifies the account; refused by the PATCH (see above). */
  email: string;
  pan_number: string | null;
  gstin_holder: boolean;
  gst_number: string | null;
  company_category: boolean | null;
  company_name: string;
  company_type_id: string | null;
  address_line1: string | null;
  address_line2: string | null;
  pincode: string | null;
  country_id: string | null;
  state_id: string | null;
  city_id: string | null;
  landline: string | null;
  mobile: string | null;
  category_ids: string[];
  legal_name: string | null;
  business_type: string | null;
  trade_license_no: string | null;
  website: string | null;
  about: string | null;
}

/* -------------------------------------------------------------------------- */
/* Request shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The token in the path.
 *
 * Bounded and character-restricted here, before the service hashes it, so a
 * multi-megabyte path segment is a 422 rather than an HMAC over attacker-chosen
 * input. The service checks the shape again — this is the polite refusal, that
 * one is the guarantee.
 */
export const tokenParamSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{20,200}$/, 'application.linkInvalid'),
});

export const documentTokenParamSchema = tokenParamSchema.extend({
  /*
    A code shape, not a fixed list.

    The three registration documents used to be an enum; the association
    configures its own checklist now, so the schema can only assert the shape
    screen A-12 enforces. Whether the code names a type the association still
    asks for is the service's call, not the parser's — an unknown code is a
    404 from `findTypeForUpload`, which is the honest answer.
  */
  documentTypeCode: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'masters.documentTypeNotFound'),
});

/** Which face of a two-sided document a replacement is for. Optional. */
export const documentSideQuerySchema = z.object({
  side: z.enum(['FRONT', 'BACK']).optional(),
});

/**
 * A key the registration form posts but this endpoint must never take.
 *
 * Declared in the shape rather than left to `.strict()` so the refusal arrives
 * as a sentence under the field the client named, in the applicant's language —
 * `{ fields: { email: "…" } }` — instead of zod's English "Unrecognized key(s)".
 * A form that posts everything it holds is the likely caller, and it deserves to
 * be told which key was the problem and why.
 */
const refused = (messageKey: string) => z.never({ invalid_type_error: messageKey }).optional();

/**
 * The correction itself. Every field optional, at least one present.
 *
 * Optional because a round may be about one typo; "at least one present" because
 * an empty PATCH is a caller mistake worth naming rather than a no-op to accept
 * silently. Since D-16 the grammar is the registration form — the same schemas,
 * imported rather than restated (see the file header) — so what the service
 * still decides is whether the *values* are free (D-17, uniqueness) and whether
 * the ids name masters that are still live.
 *
 * `.strict()` matters more here than it usually does. This is the one write path
 * with no session behind it, so an unknown key must be a refusal rather than a
 * silent drop: the applicant who posts `pan` instead of `pan_number` should be
 * told nothing was saved, not thanked for a correction that never landed.
 *
 * Nullable where the form can genuinely clear a value (`address_line2`,
 * `landline`, `gst_number` when the GSTIN box is unticked) and not nullable
 * where the row cannot be empty — `company_name`, `address_line1` and `pincode`
 * are NOT NULL columns, and "correct this to nothing" is not a correction.
 */
export const correctApplicationSchema = z
  .object({
    ...registrationFields,
    ...applicationSnapshotFields,

    /*
      Identity and consent, refused by name.

      They are in the shape precisely BECAUSE they may not be written: a key
      that is merely absent gets zod's generic unrecognised-key error, while a
      key that is present and always invalid gets to say why. See
      CORRECTABLE_FIELDS above for the reasoning behind each one.
    */
    email: refused('application.emailNotCorrectable'),
    consent_accepted: refused('application.consentNotCorrectable'),
    captcha_token: refused('application.captchaNotCorrectable'),
    captcha_answer: refused('application.captchaNotCorrectable'),
  })
  .partial()
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'application.nothingToCorrect',
        path: ['body'],
      });
    }

    /*
      The one cross-field rule, and only when the PATCH carries both halves.

      A correction that sends `gstin_holder: true` alone is not wrong — the
      GSTIN may already be on the application — so the pair is checked here for
      the case the parser can see, and again in the service against the values
      that will actually be stored. This one exists so the error lands on the
      field rather than as a 409 from a deeper layer.
    */
    if (value.gstin_holder !== undefined && value.gst_number !== undefined) {
      if (gstinHolderNeedsNumber(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'validation.requiredFields',
          path: ['gst_number'],
        });
      }
    }
  });

export type CorrectApplicationInput = z.infer<typeof correctApplicationSchema>;

/**
 * "I lost the email."
 *
 * Answers identically whether or not the address is known (spec OQ-2's resend
 * path, security.md §2 enumeration). The response says what was done for an
 * address that has a correctable application, in the abstract, and says the same
 * thing for one that does not.
 */
export const resendLinkSchema = z.object({
  email: z.string().trim().toLowerCase().email('validation.invalidEmail').max(255),
});

export type ResendLinkInput = z.infer<typeof resendLinkSchema>;

/**
 * Super admin clearing the counter (spec D-13).
 *
 * A reason is mandatory. The whole justification for this endpoint is "a genuine
 * case", and a genuine case can be written down; an audit row that records who
 * reset a limit but not why answers half the question that made the reset worth
 * auditing.
 */
export const resetResubmissionsSchema = z.object({
  reason: trimmed(500).min(1, 'application.resetReasonRequired'),
});

export type ResetResubmissionsInput = z.infer<typeof resetResubmissionsSchema>;

/**
 * Super admin reopening a CLOSED application (spec D-18).
 *
 * Same shape as the reset above and deliberately so — both are a super admin
 * overriding a rule the association set, and both are worth nothing in an audit
 * log without the sentence explaining why. Kept as its own schema rather than an
 * alias because the two endpoints are free to diverge (an expiry, a stage
 * override) without either one quietly changing the other's contract.
 */
export const reopenApplicationSchema = z.object({
  reason: trimmed(500).min(1, 'application.reopenReasonRequired'),
});

export type ReopenApplicationInput = z.infer<typeof reopenApplicationSchema>;

export const applicationIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
});
