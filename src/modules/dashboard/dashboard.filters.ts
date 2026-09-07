import { z } from 'zod';

/**
 * The filter contract every dashboard endpoint accepts.
 *
 * Shared, and that is the point: without one schema each endpoint invents its
 * own date handling, and two widgets on the same screen can silently answer for
 * two different periods. One schema, one resolver, no endpoint interpreting a
 * filter its own way.
 *
 * Dates resolve against the server's timezone, which is the association's. A
 * per-tenant timezone is not a question this platform has — there is one
 * association.
 */

export const dashboardFilterSchema = z
  .object({
    period: z
      .enum(['today', 'wtd', 'mtd', 'qtd', 'ytd', 'last_30d', 'custom'])
      .optional()
      .default('mtd'),
    /** `YYYY-MM-DD`, required together when `period` is `custom`. */
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
      .optional(),
    compare_to: z
      .enum(['previous_period', 'previous_year', 'none'])
      .optional()
      .default('previous_period'),
  })
  .refine((value) => value.period !== 'custom' || (Boolean(value.from) && Boolean(value.to)), {
    message: 'validation.customPeriodNeedsDates',
    path: ['from'],
  });

export type DashboardFilters = z.infer<typeof dashboardFilterSchema>;

export interface ResolvedPeriod {
  from: Date;
  to: Date;
  /** The window to compare against. Equal to `from`/`to` when comparison is off. */
  prevFrom: Date;
  prevTo: Date;
}

const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const endOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);

  next.setDate(next.getDate() + days);

  return next;
};

/**
 * The window a period names, and the window to compare it against.
 *
 * `previous_period` is the same LENGTH immediately before, not the previous
 * calendar unit: comparing 12 days of a month against a whole previous month
 * would report a collapse every time somebody looked before the month was out.
 *
 * `previous_year` is the same dates a year earlier, which is what an annual
 * body actually compares — this September against last September, not against
 * August.
 */
export const resolvePeriod = (
  filters: DashboardFilters,
  now: Date = new Date(),
): ResolvedPeriod => {
  const today = startOfDay(now);
  let from: Date;
  let to: Date = endOfDay(now);

  switch (filters.period) {
    case 'today':
      from = today;
      break;
    case 'wtd': {
      // Week starts Monday: an association's week does, and a Sunday start puts
      // yesterday's work in "this week" for one day and not the next.
      const weekday = (today.getDay() + 6) % 7;

      from = addDays(today, -weekday);
      break;
    }
    case 'mtd':
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      break;
    case 'qtd':
      from = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
      break;
    case 'ytd':
      from = new Date(today.getFullYear(), 0, 1);
      break;
    case 'last_30d':
      from = addDays(today, -29);
      break;
    case 'custom':
    default:
      from = startOfDay(new Date(`${filters.from as string}T00:00:00`));
      to = endOfDay(new Date(`${filters.to as string}T00:00:00`));
      break;
  }

  if (filters.compare_to === 'none') {
    // Collapsed deliberately: the caller reads `compare_to` and skips the delta,
    // and a previous window that is not there cannot be summed by accident.
    return { from, to, prevFrom: from, prevTo: to };
  }

  if (filters.compare_to === 'previous_year') {
    const shift = (date: Date): Date => {
      const next = new Date(date);

      next.setFullYear(next.getFullYear() - 1);

      return next;
    };

    return { from, to, prevFrom: shift(from), prevTo: shift(to) };
  }

  const lengthMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - lengthMs);

  return { from, to, prevFrom, prevTo };
};

/** `YYYY-MM-DD`, for a SQL date bound. */
export const asDate = (value: Date): string =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
