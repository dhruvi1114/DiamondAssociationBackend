import { prisma } from '@db/prisma';
import { logger } from '@logger/logger';

/**
 * Runtime configuration, read from `SystemSettings`.
 *
 * Values live in the database rather than env so an admin can change them
 * without a deploy (`architecture.md` §8). Anything that is a *secret* stays in
 * env and never appears here.
 *
 * Cached for 60 seconds, matching the permission cache: long enough that a hot
 * path does not hit the database on every request, short enough that changing a
 * setting takes effect while the admin is still looking at the screen.
 */

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: string | null;
  readAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop a key from the cache — call after writing it, so the change is immediate. */
export const invalidateSetting = (key: string): void => {
  cache.delete(key);
};

export const getSetting = async (key: string): Promise<string | null> => {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) return cached.value;

  const row = await prisma.systemSetting.findUnique({ where: { key }, select: { value: true } });
  const value = row?.value ?? null;
  cache.set(key, { value, readAt: Date.now() });

  return value;
};

/**
 * A numeric setting with a fallback.
 *
 * A malformed value falls back and logs loudly rather than throwing: a typo in
 * one configuration row should not take a business flow offline, but it must
 * not pass silently either.
 */
export const getNumericSetting = async (key: string, fallback: number): Promise<number> => {
  const raw = await getSetting(key);
  if (raw === null) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.error('settings.invalidNumber', { key, raw, fallback });

    return fallback;
  }

  return parsed;
};

/**
 * A boolean setting with a fallback.
 *
 * Only the exact string `'true'` is true. Anything else — `'1'`, `'yes'`, a typo,
 * a missing row — is false, because every one of these settings gates something
 * that costs money or exposes data, and the safe reading of an unclear value is
 * "not switched on".
 */
export const getBooleanSetting = async (key: string, fallback: boolean): Promise<boolean> => {
  const raw = await getSetting(key);
  if (raw === null) return fallback;

  return raw === 'true';
};

/** Keys this codebase reads. Listed here so the seed and the readers cannot drift. */
export const SETTING_KEYS = {
  /** How many times a returned application may be resubmitted. `0` = unlimited. */
  MAX_RESUBMISSIONS: 'application.max_resubmissions',
  /** Days between an invoice being issued and falling due. */
  INVOICE_DUE_DAYS: 'billing.invoice_due_days',
  /** The association's GSTIN, printed on tax invoices. Empty until supplied (OQ-8). */
  ORG_GSTIN: 'organisation.gstin',
  /** Legal name printed on invoices. */
  ORG_LEGAL_NAME: 'organisation.legal_name',
  /** Registered office address, printed under the legal name on invoices. */
  ORG_ADDRESS: 'organisation.address',
  /** Storage key of the full logo. Empty = none uploaded. */
  ORG_LOGO: 'organisation.logo',
  /** Storage key of the square mark. Empty = none uploaded. */
  ORG_LOGO_MARK: 'organisation.logo_mark',
  /** Storage key of the authorised signature image. Empty = none uploaded. */
  ORG_SIGNATURE: 'organisation.signature',
  /** Leading token of every invoice number — `IN` in `IN202603001`. */
  INVOICE_PREFIX: 'billing.invoice_prefix',
  /** Free text printed at the foot of every invoice. */
  INVOICE_FOOTER: 'billing.invoice_footer',
  /** `'term'` or `'financial_year'` — how a membership term is dated and priced. */
  RENEWAL_BASIS: 'billing.renewal_basis',
  /** Whether a one-time application fee is added to the first membership invoice. */
  CHARGE_APPLICATION_FEE: 'billing.charge_application_fee',
  /** The application fee, before tax, in the fee currency. */
  APPLICATION_FEE_AMOUNT: 'billing.application_fee_amount',
  /** Consent paragraph on the public registration form (spec D-14). */
  REGISTRATION_CONSENT_TEXT: 'registration.consent_text',
  /**
   * How many days a booking holds its seats before an unpaid hold is released.
   * Payment reminders are derived from this number rather than configured
   * separately, so shortening the hold cannot leave a reminder firing after the
   * seats are already gone.
   */
  EVENT_PAYMENT_HOLD_DAYS: 'event.payment_hold_days',
  /**
   * How long after expiry a member still gets member pricing on events. A firm
   * three days late renewing is not an outsider.
   */
  MEMBERSHIP_GRACE_DAYS: 'membership.grace_days',
  /**
   * Whether the member directory is available at all. Off closes it for every
   * member at once; it does not change any individual member's own listing
   * choice, which is theirs and is restored when this is switched back on.
   */
  DIRECTORY_ENABLED: 'directory.enabled',
} as const;

/** The two values `billing.renewal_basis` may hold. */
export type RenewalBasis = 'term' | 'financial_year';
