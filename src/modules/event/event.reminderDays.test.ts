import { describe, expect, it } from 'vitest';
import { reminderDaysFor } from '@modules/event/event.constants';

describe('reminderDaysFor', () => {
  it('sends at the midpoint and the day before expiry', () => {
    expect(reminderDaysFor(5)).toEqual([3, 4]);
    expect(reminderDaysFor(7)).toEqual([4, 6]);
  });

  it('collapses to one reminder on a short hold', () => {
    expect(reminderDaysFor(3)).toEqual([2]);
    expect(reminderDaysFor(2)).toEqual([1]);
  });

  it('sends none when there is no day left on which a warning would help', () => {
    expect(reminderDaysFor(1)).toEqual([]);
    expect(reminderDaysFor(0)).toEqual([]);
  });

  it('never schedules a reminder on or after the expiry day', () => {
    for (let hold = 1; hold <= 30; hold += 1) {
      for (const day of reminderDaysFor(hold)) {
        expect(day).toBeLessThan(hold);
        expect(day).toBeGreaterThan(0);
      }
    }
  });
});
