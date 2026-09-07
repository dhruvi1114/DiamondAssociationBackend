import type { DashboardFilters } from '@modules/dashboard/dashboard.filters';

/**
 * The shape every KPI tile arrives in.
 *
 * `delta_pct` is null whenever a comparison cannot honestly be made, so the
 * screen hides the chip rather than showing a figure that means nothing.
 */
export interface KpiValue {
  value: number;
  delta_pct: number | null;
}

export type CompareTo = DashboardFilters['compare_to'];

/**
 * Percentage change, guarded at both ends.
 *
 * Null when comparison is off, and null when the previous window was zero:
 * "nothing before" is not 0% growth, and it is not infinite growth either. The
 * only honest answer is no answer, and the tile draws no chip for it.
 */
export const deltaPct = (
  current: number,
  previous: number,
  compareTo: CompareTo = 'previous_period',
): number | null => {
  if (compareTo === 'none') return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;

  return Math.round(((current - previous) / previous) * 1000) / 10;
};

export const kpi = (
  value: number,
  previous: number,
  compareTo: CompareTo = 'previous_period',
): KpiValue => ({ value, delta_pct: deltaPct(value, previous, compareTo) });

/**
 * A figure with no prior period to compare against — a count of what is true
 * right now, like open applications.
 *
 * An honest null chip rather than a fake 0% from `kpi(value, 0, …)`.
 */
export const kpiNoDelta = (value: number): KpiValue => ({ value, delta_pct: null });
