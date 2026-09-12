import { describe, expect, it } from 'vitest';
import {
  addDays,
  daysBetween,
  dbToday,
  isoDay,
  planRenewalTerm,
} from '@modules/renewal/renewal.dates';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('renewal dates', () => {
  it('dbToday is the local calendar day as a UTC-midnight date', () => {
    const now = new Date(2027, 2, 16, 23, 59); // 16 Mar 2027, local
    expect(isoDay(dbToday(now))).toBe('2027-03-16');
  });

  it('adds and counts whole days', () => {
    expect(isoDay(addDays(day('2027-03-31'), 1))).toBe('2027-04-01');
    expect(daysBetween(day('2027-03-16'), day('2027-03-31'))).toBe(15);
  });

  it('yearly renewal under financial_year runs 1 Apr to 31 Mar, full price', () => {
    const w = planRenewalTerm({
      from: day('2027-04-01'),
      durationMonths: 12,
      basis: 'financial_year',
    });
    expect(isoDay(w.validFrom)).toBe('2027-04-01');
    expect(isoDay(w.validTill)).toBe('2028-03-31');
    expect(w.prorated).toBe(false);
  });

  it('quarterly renewal crossing 31 March is cut and prorated by whole months', () => {
    const w = planRenewalTerm({
      from: day('2027-03-12'),
      durationMonths: 3,
      basis: 'financial_year',
    });
    expect(isoDay(w.validTill)).toBe('2027-03-31');
    expect(w.months).toBe(1);
    expect(w.prorated).toBe(true);
  });

  it('monthly renewal under term runs to the day before the next anniversary', () => {
    const w = planRenewalTerm({ from: day('2026-10-12'), durationMonths: 1, basis: 'term' });
    expect(isoDay(w.validTill)).toBe('2026-11-11');
    expect(w.prorated).toBe(false);
  });
});
