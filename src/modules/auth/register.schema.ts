import { z } from 'zod';

const email = z
  .string({ required_error: 'validation.invalidEmail' })
  .trim()
  .min(1, 'validation.invalidEmail')
  .max(150, 'validation.invalidEmail')
  .email('validation.invalidEmail')
  .transform((value) => value.toLowerCase());

const trimmed = (max: number) => z.string().trim().max(max, 'validation.tooLong');

const pan = z
  .string()
  .trim()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'validation.invalidPan');

const gst = z
  .string()
  .trim()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/, 'validation.invalidGst');

const optionalId = z
  .union([z.string(), z.undefined(), z.null()])
  .transform((value) => {
    if (value === undefined || value === null) return undefined;
    const trimmedValue = String(value).trim();
    return trimmedValue.length === 0 ? undefined : trimmedValue;
  })
  .pipe(z.string().regex(/^\d+$/, 'validation.invalidId').optional());

/**
 * Every field the public registration form collects about the applicant.
 *
 * Exported as a bag of per-field schemas rather than only as the assembled
 * `registerSchema`, because a second surface has to accept exactly these fields
 * with exactly these rules: the login-free correction PATCH (spec D-16), which
 * re-renders this same form pre-filled and must reach parity with it.
 *
 * Restating the regexes there was the alternative, and it is the wrong one here.
 * `public.types.ts` deliberately does NOT share with `application.types.ts` —
 * that file guards the authenticated reviewer surface and a loosened expression
 * there must not silently loosen an anonymous write path. This file is the
 * opposite case: the correction form IS the registration form, so a PAN the
 * registration schema accepts and the correction schema refuses (or the reverse)
 * is a bug in both directions, not a safety margin. One definition is what keeps
 * them honest.
 *
 * Identity and consent are deliberately NOT in here. `email` names the account,
 * and `consent_accepted` / `captcha_*` are one-shot facts about the moment of
 * registration rather than properties of the application — so the correction
 * schema cannot accidentally inherit them by spreading this object.
 */
export const registrationFields = {
  pan_number: pan,
  gstin_holder: z.coerce.boolean(),
  gst_number: gst.optional().nullable(),
  company_category: z.coerce.boolean().optional().nullable(),
  company_name: trimmed(200).min(1, 'validation.requiredFields'),
  company_type_id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  address_line1: trimmed(200).min(1, 'validation.requiredFields'),
  address_line2: trimmed(200).nullish(),
  pincode: z
    .string()
    .trim()
    .regex(/^[0-9]{4,10}$/, 'member.invalidPincode'),
  country_id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  state_id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  city_id: optionalId,
  landline: z
    .string()
    .trim()
    .regex(/^[+]?[0-9\s-]{7,20}$/, 'validation.invalidPhone')
    .nullish(),
  mobile: z
    .string({ required_error: 'validation.invalidPhone' })
    .trim()
    .regex(/^[+]?[0-9][0-9\s-]{6,19}$/, 'validation.invalidPhone'),
  category_ids: z
    .array(z.string().regex(/^\d+$/, 'validation.invalidId'))
    .min(1, 'validation.requiredFields')
    .max(20),
} as const;

/**
 * The snapshot columns `MembershipApplications` carries but the public form does
 * not ask for yet — filled by staff, or by a correcting applicant on a form that
 * chooses to show them (D-16).
 *
 * Kept beside the form fields rather than in `public.types.ts` so there is one
 * place to look for "what shape does this column take on the wire", and kept
 * OUT of `registrationFields` so registration's payload does not silently grow a
 * field nobody put on the form.
 */
export const applicationSnapshotFields = {
  legal_name: trimmed(200).nullish(),
  business_type: trimmed(100).nullish(),
  trade_license_no: trimmed(50).nullish(),
  website: trimmed(200).nullish(),
  about: trimmed(5000).nullish(),
} as const;

/** True when a GSTIN holder supplied no GSTIN — the one cross-field rule both surfaces share. */
export const gstinHolderNeedsNumber = (value: {
  gstin_holder?: boolean | null;
  gst_number?: string | null;
}): boolean => Boolean(value.gstin_holder) && !value.gst_number;

export const registerSchema = z
  .object({
    email,
    ...registrationFields,
    consent_accepted: z.literal(true, {
      errorMap: () => ({ message: 'validation.requiredFields' }),
    }),
    captcha_token: z.string().trim().min(1, 'auth.captchaInvalid'),
    captcha_answer: z.string().trim().min(1, 'auth.captchaInvalid'),
  })
  .superRefine((value, ctx) => {
    if (gstinHolderNeedsNumber(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'validation.requiredFields',
        path: ['gst_number'],
      });
    }
  });

export type RegisterInput = z.infer<typeof registerSchema>;

export const setInitialPasswordSchema = z.object({
  token: z
    .string({ required_error: 'auth.resetTokenInvalid' })
    .trim()
    .min(1, 'auth.resetTokenInvalid'),
  password: z
    .string({ required_error: 'validation.passwordTooWeak' })
    .min(8, 'validation.passwordTooWeak')
    .max(72, 'validation.passwordTooWeak')
    .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, 'validation.passwordTooWeak'),
});

export type SetInitialPasswordInput = z.infer<typeof setInitialPasswordSchema>;
