import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { priceBooking } from '@modules/event/registration.pricing';

const tier = {
  id: 1n,
  name: 'Early bird',
  starts_on: new Date('2026-09-01T00:00:00.000Z'),
  ends_on: new Date('2026-11-15T00:00:00.000Z'),
  member_price: new Prisma.Decimal('1000'),
  non_member_price: new Prisma.Decimal('2000'),
};

const on = new Date('2026-11-10T09:00:00.000Z');

describe('priceBooking', () => {
  it('prices a member booking at the member rate, per head', () => {
    const priced = priceBooking({
      tiers: [tier],
      on,
      seats: 3,
      taxRate: new Prisma.Decimal(0),
      membershipValidTill: new Date('2027-03-31T00:00:00.000Z'),
      graceDays: 30,
    });

    expect(priced).not.toBeNull();
    expect(priced?.unitPrice.toFixed(2)).toBe('1000.00');
    expect(priced?.subtotal.toFixed(2)).toBe('3000.00');
    expect(priced?.total.toFixed(2)).toBe('3000.00');
    expect(priced?.audience).toBe('MEMBER');
  });

  it('applies tax on top of the subtotal', () => {
    const priced = priceBooking({
      tiers: [tier],
      on,
      seats: 2,
      taxRate: new Prisma.Decimal('18'),
      membershipValidTill: new Date('2027-03-31T00:00:00.000Z'),
      graceDays: 30,
    });

    expect(priced?.subtotal.toFixed(2)).toBe('2000.00');
    expect(priced?.taxAmount.toFixed(2)).toBe('360.00');
    expect(priced?.total.toFixed(2)).toBe('2360.00');
  });

  it('charges the non-member rate once the grace period is over', () => {
    const priced = priceBooking({
      tiers: [tier],
      on,
      seats: 1,
      taxRate: new Prisma.Decimal(0),
      membershipValidTill: new Date('2026-01-01T00:00:00.000Z'),
      graceDays: 30,
    });

    expect(priced?.audience).toBe('NON_MEMBER');
    expect(priced?.unitPrice.toFixed(2)).toBe('2000.00');
  });

  it('still charges the member rate inside the grace period', () => {
    const priced = priceBooking({
      tiers: [tier],
      on,
      seats: 1,
      taxRate: new Prisma.Decimal(0),
      membershipValidTill: new Date('2026-10-25T00:00:00.000Z'),
      graceDays: 30,
    });

    expect(priced?.audience).toBe('MEMBER');
    expect(priced?.unitPrice.toFixed(2)).toBe('1000.00');
  });

  it('charges a guest the non-member rate', () => {
    const priced = priceBooking({
      tiers: [tier],
      on,
      seats: 1,
      taxRate: new Prisma.Decimal(0),
      membershipValidTill: null,
      graceDays: 30,
    });

    expect(priced?.audience).toBe('NON_MEMBER');
    expect(priced?.unitPrice.toFixed(2)).toBe('2000.00');
  });

  /*
    The refusal that matters: outside every window there is no price, so the
    booking cannot be made. A fallback here would be a figure nobody agreed to.
  */
  it('returns null when no tier covers the booking date', () => {
    const priced = priceBooking({
      tiers: [tier],
      on: new Date('2026-12-20T09:00:00.000Z'),
      seats: 1,
      taxRate: new Prisma.Decimal(0),
      membershipValidTill: null,
      graceDays: 30,
    });

    expect(priced).toBeNull();
  });

  it('prices a free event at zero rather than refusing it', () => {
    const free = {
      ...tier,
      member_price: new Prisma.Decimal(0),
      non_member_price: new Prisma.Decimal(0),
    };

    const priced = priceBooking({
      tiers: [free],
      on,
      seats: 4,
      taxRate: new Prisma.Decimal('18'),
      membershipValidTill: new Date('2027-03-31T00:00:00.000Z'),
      graceDays: 30,
    });

    expect(priced?.total.toFixed(2)).toBe('0.00');
    expect(priced?.isFree).toBe(true);
  });
});
