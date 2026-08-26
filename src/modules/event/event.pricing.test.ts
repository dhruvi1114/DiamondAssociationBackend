import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { audienceFor, resolveTier, unitPrice } from '@modules/event/event.pricing';

const tier = (
  id: number,
  name: string,
  starts: string,
  ends: string,
  member: string,
  nonMember: string,
) => ({
  id: BigInt(id),
  name,
  starts_on: new Date(`${starts}T00:00:00.000Z`),
  ends_on: new Date(`${ends}T00:00:00.000Z`),
  member_price: new Prisma.Decimal(member),
  non_member_price: new Prisma.Decimal(nonMember),
});

const TIERS = [
  tier(1, 'Early bird', '2026-09-01', '2026-11-15', '1000', '2000'),
  tier(2, 'Regular', '2026-11-16', '2026-12-05', '1500', '2500'),
  tier(3, 'Late', '2026-12-06', '2026-12-10', '2000', '3000'),
];

const at = (iso: string) => new Date(iso);

describe('resolveTier', () => {
  it('picks the window the booking date falls in', () => {
    expect(resolveTier(TIERS, at('2026-11-10T09:00:00.000Z'))?.name).toBe('Early bird');
    expect(resolveTier(TIERS, at('2026-11-20T09:00:00.000Z'))?.name).toBe('Regular');
    expect(resolveTier(TIERS, at('2026-12-08T09:00:00.000Z'))?.name).toBe('Late');
  });

  it('keeps a tier until the very end of its last day', () => {
    expect(resolveTier(TIERS, at('2026-11-15T23:55:00.000Z'))?.name).toBe('Early bird');
    expect(resolveTier(TIERS, at('2026-11-16T00:05:00.000Z'))?.name).toBe('Regular');
  });

  it('includes the first moment of a tier', () => {
    expect(resolveTier(TIERS, at('2026-09-01T00:00:00.000Z'))?.name).toBe('Early bird');
  });

  it('returns null outside every window rather than guessing a price', () => {
    expect(resolveTier(TIERS, at('2026-08-31T12:00:00.000Z'))).toBeNull();
    expect(resolveTier(TIERS, at('2026-12-11T12:00:00.000Z'))).toBeNull();
  });

  it('returns null when an event has no tiers at all', () => {
    expect(resolveTier([], at('2026-11-10T09:00:00.000Z'))).toBeNull();
  });
});

describe('audienceFor', () => {
  const validTill = new Date('2027-03-31T00:00:00.000Z');

  it('treats a live membership as a member', () => {
    expect(
      audienceFor({
        membershipValidTill: validTill,
        graceDays: 30,
        on: at('2027-03-01T00:00:00.000Z'),
      }),
    ).toBe('MEMBER');
  });

  it('keeps member pricing throughout the grace period', () => {
    expect(
      audienceFor({
        membershipValidTill: validTill,
        graceDays: 30,
        on: at('2027-04-05T00:00:00.000Z'),
      }),
    ).toBe('MEMBER');
    expect(
      audienceFor({
        membershipValidTill: validTill,
        graceDays: 30,
        on: at('2027-04-30T23:59:00.000Z'),
      }),
    ).toBe('MEMBER');
  });

  it('drops to non-member pricing the day after grace ends', () => {
    expect(
      audienceFor({
        membershipValidTill: validTill,
        graceDays: 30,
        on: at('2027-05-01T00:00:00.000Z'),
      }),
    ).toBe('NON_MEMBER');
  });

  it('treats someone with no membership at all as a non-member', () => {
    expect(
      audienceFor({ membershipValidTill: null, graceDays: 30, on: at('2026-11-10T00:00:00.000Z') }),
    ).toBe('NON_MEMBER');
  });

  it('honours a zero-day grace period', () => {
    expect(
      audienceFor({
        membershipValidTill: validTill,
        graceDays: 0,
        on: at('2027-03-31T12:00:00.000Z'),
      }),
    ).toBe('MEMBER');
    expect(
      audienceFor({
        membershipValidTill: validTill,
        graceDays: 0,
        on: at('2027-04-01T00:00:00.000Z'),
      }),
    ).toBe('NON_MEMBER');
  });
});

describe('unitPrice', () => {
  it('reads the column matching the audience', () => {
    expect(unitPrice(TIERS[0], 'MEMBER').toString()).toBe('1000');
    expect(unitPrice(TIERS[0], 'NON_MEMBER').toString()).toBe('2000');
  });
});
