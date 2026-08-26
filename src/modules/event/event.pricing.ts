import type { Prisma } from '@prisma/client';

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
