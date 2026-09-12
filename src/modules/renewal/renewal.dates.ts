import { planTerm, type TermWindow } from '@helpers/membershipTerm';
import type { RenewalBasis } from '@helpers/settings';

/**
 * Calendar days for renewal.
 *
 * A `@db.Date` column reads back as UTC midnight, while `planTerm` does its arithmetic on the
 * local calendar. Every renewal date passes through here so the two never meet raw: the day the
 * admin would name is the day that is stored, whatever timezone the server runs in.
 */

export const DAY_MS = 86_400_000;

/** Today on the server's local calendar, as the UTC-midnight Date a DATE column stores. */
export const dbToday = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

export const addDays = (day: Date, n: number): Date => new Date(day.getTime() + n * DAY_MS);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / DAY_MS);

export const isoDay = (day: Date): string => day.toISOString().slice(0, 10);

const toLocal = (day: Date): Date =>
  new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());

const toDb = (local: Date): Date =>
  new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));

/**
 * `planTerm` for a renewal. Same arithmetic as joining — two copies of a pro-rata rule is how a
 * member ends up billed differently for joining than for renewing — with the dates converted in
 * and out so a DATE column's UTC midnight never lands on the wrong local day.
 */
export const planRenewalTerm = (params: {
  from: Date;
  durationMonths: number;
  basis: RenewalBasis;
}): TermWindow => {
  const window = planTerm({
    from: toLocal(params.from),
    durationMonths: params.durationMonths,
    basis: params.basis,
  });

  return { ...window, validFrom: toDb(window.validFrom), validTill: toDb(window.validTill) };
};
