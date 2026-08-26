import type { RenewalBasis } from '@helpers/settings';

/**
 * When a membership term starts, when it ends, and how much of it is being
 * billed.
 *
 * Two ways to date a term, chosen by `billing.renewal_basis`:
 *
 *  - **`term`** — the term runs the fee's own `duration_months` from the day it
 *    starts. Join on 1 Aug 2026 with a 12-month fee and the term ends 31 Jul
 *    2027. Every member has their own renewal date.
 *
 *  - **`financial_year`** — every term ends on 31 March, so the whole federation
 *    renews together. A member joining part-way through the year gets the months
 *    that are left and is charged for those months only. Join on 15 Jan 2027 and
 *    the term ends 31 Mar 2027 — three months, at three twelfths of the fee.
 *
 * Kept out of the activation service because renewal needs exactly the same
 * arithmetic, and two copies of a pro-rata calculation is how a member ends up
 * billed differently for joining than for renewing.
 *
 * All arithmetic uses the local calendar, matching the rest of the term code. A
 * term boundary is a calendar date the member reads off an invoice, not an
 * instant, so it must land on the date the admin would say it does.
 */

export interface TermWindow {
  validFrom: Date;
  /** Last day of the term, inclusive. */
  validTill: Date;
  /** Months actually being billed. */
  months: number;
  /** Months the fee is priced for — the denominator of the pro-rata fraction. */
  durationMonths: number;
  /** True when `months < durationMonths`, i.e. this term is charged part-price. */
  prorated: boolean;
}

/**
 * The 31 March that closes the Indian financial year containing `on`.
 *
 * Fixed at 1 April – 31 March rather than configurable: it is set by statute,
 * not by the association, and `financialYear()` in `documentNumber.ts` already
 * assumes it. A second, editable definition of the year would let the invoice
 * number and the term end date disagree about which year it is.
 */
export const financialYearEnd = (on: Date): Date => {
  // getMonth() is 0-based, so 3 is April: on or after April, the year closes
  // next March; before April, it closes this March.
  const closingYear = on.getMonth() >= 3 ? on.getFullYear() + 1 : on.getFullYear();

  return new Date(closingYear, 2, 31);
};

/** Whole calendar months from `from`'s month to `to`'s month, both counted. */
const monthsInclusive = (from: Date, to: Date): number =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1;

/** `from` plus `months` months, then back one day — a term ends the day before its anniversary. */
const anniversaryEve = (from: Date, months: number): Date => {
  const end = new Date(from);

  end.setMonth(end.getMonth() + months);
  // 1 Apr 2026 + 12 months ends 31 Mar 2027, not 1 Apr 2027, or every renewal
  // would overlap its predecessor by a day.
  end.setDate(end.getDate() - 1);

  return end;
};

export const planTerm = (params: {
  from: Date;
  durationMonths: number;
  basis: RenewalBasis;
}): TermWindow => {
  const { from, durationMonths, basis } = params;
  const full = anniversaryEve(from, durationMonths);

  const window = (validTill: Date, months: number): TermWindow => ({
    validFrom: from,
    validTill,
    months,
    durationMonths,
    prorated: months < durationMonths,
  });

  if (basis !== 'financial_year') return window(full, durationMonths);

  const yearEnd = financialYearEnd(from);

  /*
    Only ever shortens a term, never extends one.

    A fee priced for six months does not become a twelve-month membership
    because the financial year happens to have twelve months left in it — the
    member would be given half a year nobody charged for. Whichever end date
    comes first is the real one.
  */
  if (yearEnd >= full) return window(full, durationMonths);

  return window(yearEnd, monthsInclusive(from, yearEnd));
};
