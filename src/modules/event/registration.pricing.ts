import { Prisma } from '@prisma/client';
import { audienceFor, resolveTier, unitPrice } from '@modules/event/event.pricing';
import type { Audience, PriceTier } from '@modules/event/event.pricing';

/**
 * What a booking costs, decided once and then frozen.
 *
 * Everything here is computed at the moment of booking and written onto the row.
 * Nothing recomputes a price afterwards, which is what makes "book early, pay
 * less" hold even when the money arrives three weeks later — and what makes an
 * old attendee report still show what was actually charged.
 */

export interface PricedBooking {
  tier: PriceTier;
  audience: Audience;
  /** The per-head price, frozen onto every attendee row. */
  unitPrice: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  /** A free event skips the invoice and confirms immediately. */
  isFree: boolean;
}

export interface PriceBookingInput {
  tiers: PriceTier[];
  /** The booking date — not the payment date. This is the whole rule. */
  on: Date;
  seats: number;
  taxRate: Prisma.Decimal;
  /** When the booker's membership runs out, or null for a guest. */
  membershipValidTill: Date | null;
  graceDays: number;
}

/**
 * Price a booking, or refuse it.
 *
 * Null means no tier covers the booking date, so there is no price and the
 * booking cannot proceed. That is a real answer, not a failure: inventing a
 * fallback would charge a figure nobody agreed to, which is how billing disputes
 * start.
 */
export const priceBooking = (input: PriceBookingInput): PricedBooking | null => {
  const tier = resolveTier(input.tiers, input.on);

  if (!tier) return null;

  const audience = audienceFor({
    membershipValidTill: input.membershipValidTill,
    graceDays: input.graceDays,
    on: input.on,
  });

  const price = unitPrice(tier, audience);
  const subtotal = price.mul(input.seats);

  // Rounded to paise at the line, not carried to full precision and rounded at
  // the end: the invoice has to add up to the figure the payer was quoted.
  const taxAmount = subtotal.mul(input.taxRate).div(100).toDecimalPlaces(2);
  const total = subtotal.add(taxAmount);

  return {
    tier,
    audience,
    unitPrice: price,
    subtotal,
    taxAmount,
    total,
    isFree: total.isZero(),
  };
};
