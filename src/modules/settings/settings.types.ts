import { z } from 'zod';

/**
 * Validation for the settings a super admin may change (screen A-34).
 *
 * The rules live here rather than in the database because they are *semantic*,
 * not structural: `value_type` says a value parses as a number, it cannot say
 * that 0 means unlimited or that a GSTIN is 15 characters. Every rule below is
 * lifted from the code that reads the setting, so a value this schema accepts is
 * one that consumer can actually use.
 */

/** GSTIN: 2-digit state, 5 letters, 4 digits, letter, digit/letter, Z, checksum. */
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

const email = z.string().trim().email('validation.invalidEmail');
const nonEmpty = z.string().trim().min(1, 'validation.required').max(200);
const boolean = z.enum(['true', 'false']);

/**
 * Free text that may run to several lines and may legitimately be empty — an
 * address, an invoice footer. Trimmed at the ends only: the line breaks inside
 * are the whole point, and collapsing them would reformat the address someone
 * typed.
 */
const multiline = (max: number) => z.string().trim().max(max, 'validation.tooLong');

/**
 * A money amount, as the string every setting is stored as. Two decimal places
 * because that is what `Prisma.Decimal` writes back and what an invoice prints;
 * a third would be accepted here and then silently rounded on the invoice.
 */
const money = (max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'validation.invalidAmount')
    .refine((raw) => Number(raw) <= max, 'validation.outOfRange');

/** A whole number in `[min, max]`, arriving as the string every setting is stored as. */
const wholeNumber = (min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, 'validation.invalidNumber')
    .refine((raw) => Number(raw) >= min && Number(raw) <= max, 'validation.outOfRange');

/**
 * One rule per editable key. A key absent from here is NOT editable through the
 * API — an allow-list rather than a deny-list, so a new setting has to be
 * considered before it becomes editable, and a typo'd key is a 422 rather than
 * a row nothing reads.
 */
export const EDITABLE_SETTINGS: Record<string, z.ZodType<string>> = {
  'organisation.name': nonEmpty,
  'organisation.legal_name': nonEmpty,
  'organisation.support_email': email,
  // Empty is legitimate and meaningful: it is how the system says "no GSTIN yet,
  // do not issue tax invoices" (OQ-8). Anything non-empty must be a real GSTIN.
  'organisation.gstin': z.union([
    z.literal(''),
    z.string().trim().regex(GSTIN, 'validation.invalidGst'),
  ]),
  'notification.email_enabled': boolean,
  'notification.whatsapp_enabled': boolean,
  'notification.in_app_enabled': boolean,
  // Bounded, because it is added to a date. Unbounded, a typo'd 150 quietly moves
  // every invoice five months out and nobody notices for weeks.
  'billing.invoice_due_days': wholeNumber(0, 365),
  // 0 means UNLIMITED here, not none — see `approval.engine.ts`. The bound is a
  // sanity cap, not a business rule.
  'application.max_resubmissions': wholeNumber(0, 20),
  'directory.public_enabled': boolean,
  'organisation.address': multiline(500),
  /*
    Uploaded, not typed. The value is a storage key, and a key an admin could
    write by hand is a key an admin could point at somebody else's file — the
    branding endpoint is the only thing allowed to set one. Empty is still
    accepted, because that is how the screen says "remove the logo".
  */
  'organisation.logo': z.literal(''),
  'organisation.logo_mark': z.literal(''),
  /*
    Uppercase letters and digits only, and short. It is concatenated straight
    into the invoice number with no separator (`IN` + `202603` + `001`), so a
    space or a slash would produce a number that does not match the format the
    client signed off, and a lowercase one would sort differently everywhere.
  */
  'billing.invoice_prefix': z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{1,10}$/, 'validation.invalidPrefix'),
  'billing.invoice_footer': multiline(500),
  'billing.renewal_basis': z.enum(['term', 'financial_year']),
  'billing.charge_application_fee': boolean,
  // Capped well above any plausible fee. The cap is a typo guard, not a policy:
  // an extra zero on an application fee reaches a real member as a real invoice.
  'billing.application_fee_amount': money(10_000_000),
  /*
    Bounded hard. This number freezes seats: set it to 500 by mistake and every
    unpaid booking holds its seats for over a year, which silently sells out
    every event. One day is the floor because a hold shorter than that expires
    before a bank transfer can clear.
  */
  'event.payment_hold_days': wholeNumber(1, 30),
  // A grace period, not a second membership term — a year of grace would mean
  // expiry never actually costs anything.
  'membership.grace_days': wholeNumber(0, 365),
};

export const updateSettingsSchema = z.object({
  /**
   * A batch, because the screen saves a batch. One request per changed field
   * would make a half-applied save the normal outcome of pressing Save once.
   */
  settings: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        value: z.string().max(2000),
      }),
    )
    .min(1, 'validation.required')
    .max(50),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
