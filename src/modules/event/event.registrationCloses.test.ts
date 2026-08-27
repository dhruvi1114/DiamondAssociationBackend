import { describe, expect, it } from 'vitest';
import { createEventSchema } from '@modules/event/event.types';

/**
 * A stated deadline has to leave a clear day before the event.
 *
 * The start day used to be accepted, which let an event running 1–10 Sep take a
 * booking on the morning of the 1st — after the badges are printed and the
 * caterer's count has gone in. Client decision, 2026-08-27.
 */
const base = {
  title: 'Annual Export Summit 2026',
  start_at: '2026-09-01T09:00:00.000Z',
  end_at: '2026-09-10T18:00:00.000Z',
  price_tiers: [
    {
      name: 'Regular',
      starts_on: '2026-08-01',
      ends_on: '2026-08-31',
      member_price: 1000,
      non_member_price: 2000,
    },
  ],
};

const closesAt = (value: string | null) =>
  createEventSchema.safeParse({ ...base, registration_closes_at: value });

describe('registration deadline', () => {
  it('accepts the day before the event starts', () => {
    expect(closesAt('2026-08-31T00:00:00.000Z').success).toBe(true);
  });

  it('refuses the day the event starts', () => {
    const result = closesAt('2026-09-01T00:00:00.000Z');

    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('registrationClosesAfterStart');
  });

  it('refuses a time earlier on the start day, not just the start instant', () => {
    // 08:00 on the morning of a 09:00 event is still the start day.
    expect(closesAt('2026-09-01T08:00:00.000Z').success).toBe(false);
  });

  it('refuses a day after the event has begun', () => {
    expect(closesAt('2026-09-05T00:00:00.000Z').success).toBe(false);
  });

  it('allows no deadline at all — blank means open until the event begins', () => {
    expect(closesAt(null).success).toBe(true);
  });
});
