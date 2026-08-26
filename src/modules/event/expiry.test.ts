import { describe, expect, it } from 'vitest';
import { dueReminders } from '@modules/event/expiry.service';

const at = (iso: string) => new Date(iso);

describe('dueReminders', () => {
  /*
    A 5-day hold booked on the 10th expires on the 15th. reminderDaysFor(5) says
    remind on days 3 and 4 — the 13th and the 14th.
  */
  const held = {
    registered: at('2026-11-10T09:00:00.000Z'),
    expires: at('2026-11-15T09:00:00.000Z'),
  };

  it('says nothing on the day of booking', () => {
    expect(dueReminders(held, at('2026-11-10T23:00:00.000Z'), 5)).toBe(false);
  });

  it('says nothing on day 1 or day 2 — the reader has plenty of time', () => {
    expect(dueReminders(held, at('2026-11-11T09:00:00.000Z'), 5)).toBe(false);
    expect(dueReminders(held, at('2026-11-12T09:00:00.000Z'), 5)).toBe(false);
  });

  it('reminds on the midpoint day and the day before expiry', () => {
    expect(dueReminders(held, at('2026-11-13T09:00:00.000Z'), 5)).toBe(true);
    expect(dueReminders(held, at('2026-11-14T09:00:00.000Z'), 5)).toBe(true);
  });

  /*
    On the expiry day the sweep releases the seats. A reminder that morning would
    be advice the reader has no time left to act on.
  */
  it('does not remind on the expiry day itself', () => {
    expect(dueReminders(held, at('2026-11-15T09:00:00.000Z'), 5)).toBe(false);
  });

  it('follows the configured hold length rather than a fixed schedule', () => {
    const week = {
      registered: at('2026-11-10T00:00:00.000Z'),
      expires: at('2026-11-17T00:00:00.000Z'),
    };

    // reminderDaysFor(7) -> [4, 6]
    expect(dueReminders(week, at('2026-11-13T09:00:00.000Z'), 7)).toBe(false);
    expect(dueReminders(week, at('2026-11-14T09:00:00.000Z'), 7)).toBe(true);
    expect(dueReminders(week, at('2026-11-16T09:00:00.000Z'), 7)).toBe(true);
  });

  it('never reminds on a one-day hold — there is no day left to warn on', () => {
    const short = {
      registered: at('2026-11-10T00:00:00.000Z'),
      expires: at('2026-11-11T00:00:00.000Z'),
    };

    expect(dueReminders(short, at('2026-11-10T12:00:00.000Z'), 1)).toBe(false);
  });
});
