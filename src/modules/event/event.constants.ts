/**
 * Integer enum codes and derived numbers for the event module.
 *
 * Codes are `smallint` in the database rather than native enums, the convention
 * for tables created from M7 onward, and they are append-only — rows keep
 * whatever number was written into them, so a value is never renumbered or
 * reused. CHECK constraints enforce the ranges.
 */

export const EVENT_VISIBILITY = {
  /** Absent from every public query, not merely hidden after fetching. */
  MEMBER_ONLY: 0,
  /** Listed publicly; non-members may register. */
  PUBLIC: 1,
} as const;

export type EventVisibility = (typeof EVENT_VISIBILITY)[keyof typeof EVENT_VISIBILITY];

export const EVENT_STATUS = {
  /** Being prepared. Invisible to everyone but staff. */
  DRAFT: 0,
  /** Live. The only status in which registration is possible. */
  PUBLISHED: 1,
  /** Called off. Paid registrations are refunded as part of cancelling. */
  CANCELLED: 2,
  /** Finished. Set once the end date has passed. */
  COMPLETED: 3,
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

/**
 * Which days of the payment hold get a reminder email.
 *
 * Derived from the hold length rather than stored as its own setting. With two
 * independent numbers, shortening the hold from 5 days to 3 would silently leave
 * a "reminder on day 4" that fires after the seats are already released — a
 * setting that is wrong in a way nobody notices until a member complains.
 *
 * Midpoint, then the day before expiry, de-duplicated. A one-day hold gets none:
 * there is no day left on which a warning would still be useful.
 */
export const reminderDaysFor = (holdDays: number): number[] => {
  if (holdDays < 2) return [];

  const days = new Set<number>([Math.ceil(holdDays / 2), holdDays - 1]);

  return [...days].filter((day) => day >= 1 && day < holdDays).sort((a, b) => a - b);
};
