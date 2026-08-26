import { describe, expect, it } from 'vitest';
import { createEventSchema } from '@modules/event/event.types';

const base = {
  title: 'Export Summit 2026',
  start_at: '2026-12-15T09:00:00.000Z',
  end_at: '2026-12-15T18:00:00.000Z',
  capacity: 100,
  price_tiers: [
    {
      name: 'Early bird',
      starts_on: '2026-09-01',
      ends_on: '2026-11-15',
      member_price: 1000,
      non_member_price: 2000,
    },
    {
      name: 'Regular',
      starts_on: '2026-11-16',
      ends_on: '2026-12-05',
      member_price: 1500,
      non_member_price: 2500,
    },
  ],
};

describe('createEventSchema', () => {
  it('accepts a well-formed event', () => {
    expect(createEventSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an event that ends before it starts', () => {
    expect(
      createEventSchema.safeParse({ ...base, end_at: '2026-12-14T09:00:00.000Z' }).success,
    ).toBe(false);
  });

  it('rejects two price tiers that share a day', () => {
    const result = createEventSchema.safeParse({
      ...base,
      price_tiers: [{ ...base.price_tiers[0], ends_on: '2026-11-16' }, base.price_tiers[1]],
    });

    expect(result.success).toBe(false);
  });

  it('accepts tiers that merely touch without overlapping', () => {
    expect(createEventSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an event with no price tier — free is a zero tier, not no tier', () => {
    expect(createEventSchema.safeParse({ ...base, price_tiers: [] }).success).toBe(false);
  });

  it('rejects registration closing after the event has started', () => {
    expect(
      createEventSchema.safeParse({ ...base, registration_closes_at: '2026-12-16T00:00:00.000Z' })
        .success,
    ).toBe(false);
  });

  it('rejects a registration window that closes before it opens', () => {
    expect(
      createEventSchema.safeParse({
        ...base,
        registration_opens_at: '2026-11-01T00:00:00.000Z',
        registration_closes_at: '2026-10-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects a negative price', () => {
    expect(
      createEventSchema.safeParse({
        ...base,
        price_tiers: [{ ...base.price_tiers[0], member_price: -1 }],
      }).success,
    ).toBe(false);
  });

  it('defaults a new event to members-only, no approval, food preference on', () => {
    const parsed = createEventSchema.parse(base);

    expect(parsed.visibility).toBe(0);
    expect(parsed.requires_approval).toBe(false);
    expect(parsed.collect_food_preference).toBe(true);
    expect(parsed.collect_photo).toBe(false);
    expect(parsed.country).toBe('India');
  });
});
