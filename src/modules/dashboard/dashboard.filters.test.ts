import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '@modules/dashboard/dashboard.filters';
import { deltaPct, kpi, kpiNoDelta } from '@modules/dashboard/dashboard.kpi';

/** A Wednesday, mid-month, mid-quarter — every branch has something to cut. */
const NOW = new Date(2026, 8, 16, 14, 30);

const day = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

describe('resolvePeriod', () => {
  it('starts the week on Monday', () => {
    const { from } = resolvePeriod({ period: 'wtd', compare_to: 'none' } as never, NOW);

    // 16 Sep 2026 is a Wednesday; the week began on the 14th.
    expect(day(from)).toBe('2026-9-14');
  });

  it('runs month-to-date from the first', () => {
    const { from } = resolvePeriod({ period: 'mtd', compare_to: 'none' } as never, NOW);

    expect(day(from)).toBe('2026-9-1');
  });

  it('runs quarter-to-date from the quarter start', () => {
    const { from } = resolvePeriod({ period: 'qtd', compare_to: 'none' } as never, NOW);

    // September is in the July–September quarter.
    expect(day(from)).toBe('2026-7-1');
  });

  it('counts last 30 days inclusive of today', () => {
    const { from } = resolvePeriod({ period: 'last_30d', compare_to: 'none' } as never, NOW);

    expect(day(from)).toBe('2026-8-18');
  });

  /*
    The comparison window is the same LENGTH immediately before, not the previous
    calendar month. Comparing 16 days against a whole previous month would report
    a collapse every time anyone looked before the month was out.
  */
  it('compares against the same length immediately before', () => {
    const { from, prevFrom, prevTo } = resolvePeriod(
      { period: 'mtd', compare_to: 'previous_period' } as never,
      NOW,
    );

    expect(prevTo.getTime()).toBe(from.getTime() - 1);
    expect(prevTo.getTime() - prevFrom.getTime()).toBeGreaterThan(0);
  });

  it('compares against the same dates a year earlier', () => {
    const { prevFrom } = resolvePeriod(
      { period: 'mtd', compare_to: 'previous_year' } as never,
      NOW,
    );

    expect(day(prevFrom)).toBe('2025-9-1');
  });

  /* Collapsed so nothing can sum a window the caller said not to compare. */
  it('collapses the comparison window when comparison is off', () => {
    const { from, to, prevFrom, prevTo } = resolvePeriod(
      { period: 'mtd', compare_to: 'none' } as never,
      NOW,
    );

    expect(prevFrom.getTime()).toBe(from.getTime());
    expect(prevTo.getTime()).toBe(to.getTime());
  });
});

describe('deltaPct', () => {
  it('reports a rise', () => {
    expect(deltaPct(110, 100)).toBe(10);
  });

  /* "Nothing before" is not 0% growth, and not infinite growth either. */
  it('answers null when the previous window was zero', () => {
    expect(deltaPct(50, 0)).toBeNull();
  });

  it('answers null when comparison is off', () => {
    expect(deltaPct(110, 100, 'none')).toBeNull();
  });

  it('rounds to one decimal', () => {
    expect(deltaPct(1234, 1000)).toBe(23.4);
  });
});

describe('kpi helpers', () => {
  it('carries the value and its delta', () => {
    expect(kpi(110, 100)).toEqual({ value: 110, delta_pct: 10 });
  });

  /* A point-in-time count has no prior period; a fake 0% would claim it does. */
  it('gives a point-in-time figure no delta at all', () => {
    expect(kpiNoDelta(5)).toEqual({ value: 5, delta_pct: null });
  });
});
