import type { Prisma } from '@prisma/client';
import { TermStatus } from '@prisma/client';

/**
 * Which price applies, and to whom.
 *
 * Pure functions with no database access, so every boundary — the last minute of
 * a tier, the last day of a grace period, an event with no tiers — is testable
 * without a fixture. The registration transaction calls these once and freezes
 * the answer onto the row; nothing recomputes a price afterwards, which is what
 * makes "book early, pay less" hold even when payment arrives weeks later.
 */

export interface PriceTier {
  id: bigint;
  name: string;
  starts_on: Date;
  ends_on: Date;
  member_price: Prisma.Decimal;
  non_member_price: Prisma.Decimal;
}

export type Audience = 'MEMBER' | 'NON_MEMBER';

/**
 * The term's `valid_till`, or null if the term must not count for pricing.
 *
 * A term is only "the member's active cover" when its invoice has actually
 * been paid:
 *
 * - `ACTIVE` counts — that is what the status means.
 * - `PENDING_PAYMENT` must NOT count. The term was created alongside its
 *   invoice, but "membership is not active until that invoice is paid" (see
 *   the schema comment on `TermStatus.PENDING_PAYMENT`). Passing its
 *   `valid_till` through would let an applicant who has never paid a rupee
 *   book at member rates purely because a future end-date exists on a term
 *   that never went live.
 * - `CANCELLED` must NOT count — the term was voided, e.g. because the
 *   application behind it was reversed. There is no membership left to price.
 * - `EXPIRED` counts, deliberately, and its `valid_till` is passed through
 *   unchanged. `audienceFor`'s `graceDays` window exists precisely to keep
 *   pricing a member for a short, configured tolerance after a term's end
 *   date lapses — "a firm three days late renewing is not an outsider." An
 *   `EXPIRED` term is exactly that case: it ran past `valid_till` without a
 *   renewal, which is what makes its status `EXPIRED` in the first place.
 *   Refusing to hand its `valid_till` to `audienceFor` here would not exclude
 *   expired members from grace — it would zero the grace period out entirely,
 *   silently overriding a setting the association configured on purpose. The
 *   decision of whether "past valid_till" is still close enough belongs to
 *   `audienceFor` and `graceDays`, not to this status gate.
 *
 * Both the events list/detail path and the actual booking-price path must
 * apply this same rule, so it lives here once rather than as two hand-written
 * status checks that can drift apart.
 */
export const effectiveMembershipValidTill = (
  term: { status: TermStatus; valid_till: Date } | null | undefined,
): Date | null => {
  if (!term) return null;

  if (term.status === TermStatus.PENDING_PAYMENT || term.status === TermStatus.CANCELLED) {
    return null;
  }

  // ACTIVE and EXPIRED both count; EXPIRED relies on audienceFor's graceDays
  // to decide how long past valid_till still prices as a member.
  return term.valid_till;
};

/** Midnight UTC at the start of the day the instant falls in. */
const startOfDay = (date: Date): number =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

const DAY_MS = 86_400_000;

/**
 * The tier covering `on`, or null.
 *
 * Both ends are inclusive and compared by day, not by instant. `ends_on` is a
 * DATE column, so it arrives as midnight; a naive `on <= ends_on` would end the
 * tier a full day early and quietly overcharge everyone who books on its last
 * afternoon.
 *
 * Null is a real answer, not a failure: outside every window there is no price,
 * and the caller must refuse the booking rather than invent one. The database
 * guarantees at most one tier can match.
 */
export const resolveTier = (tiers: PriceTier[], on: Date): PriceTier | null => {
  const day = startOfDay(on);

  return (
    tiers.find((tier) => startOfDay(tier.starts_on) <= day && day <= startOfDay(tier.ends_on)) ??
    null
  );
};

/**
 * Member or non-member price, for a booking made on `on`.
 *
 * A membership that expired inside the grace window still counts as a member: a
 * firm three days late renewing is not an outsider. Past the window it is, and
 * the screen says so with a renew prompt rather than silently charging double.
 */
export const audienceFor = (input: {
  membershipValidTill: Date | null;
  graceDays: number;
  on: Date;
}): Audience => {
  if (!input.membershipValidTill) return 'NON_MEMBER';

  const graceEndsAfter = startOfDay(input.membershipValidTill) + input.graceDays * DAY_MS;

  return startOfDay(input.on) <= graceEndsAfter ? 'MEMBER' : 'NON_MEMBER';
};

/** The per-delegate price for this tier and audience. */
export const unitPrice = (tier: PriceTier, audience: Audience): Prisma.Decimal =>
  audience === 'MEMBER' ? tier.member_price : tier.non_member_price;
