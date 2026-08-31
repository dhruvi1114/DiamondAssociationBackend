/**
 * Why a caller was refused the directory.
 *
 * The code travels to the customer app so it can show the right call to action
 * — "pay now" is a different screen from "renew". It carries no member data,
 * which is the point: a refusal must not disclose what it is refusing.
 */
export const DIRECTORY_DENY = {
  /** Signed in, but this login belongs to no company at all. */
  NO_MEMBERSHIP: 'NO_MEMBERSHIP',
  /** Approved or still applying — the first invoice is not paid. */
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  /** Term ended without renewal. */
  EXPIRED: 'EXPIRED',
  /** Withdrawn by the association. */
  SUSPENDED: 'SUSPENDED',
  /** The association has switched the directory off entirely. */
  DIRECTORY_OFF: 'DIRECTORY_OFF',
} as const;

export type DirectoryDenyReason = (typeof DIRECTORY_DENY)[keyof typeof DIRECTORY_DENY];

/** Rows per page. A hard server cap — `?limit=10000` still returns 24. */
export const DIRECTORY_PAGE_SIZE = 24;

/** How many category and city facets the filter dropdowns are given. */
export const DIRECTORY_FACET_LIMIT = 50;
