/**
 * Integer enum codes for bookings.
 *
 * `smallint` in the database rather than native enums, per the M7 convention,
 * and append-only: rows keep whatever number was written into them.
 */

export const REGISTRATION_STATUS = {
  /** Waiting for staff, on an event that vets its attendees. No invoice exists yet. */
  PENDING_APPROVAL: 0,
  /** Invoice raised, seats held, waiting for the money. */
  PENDING_PAYMENT: 1,
  /** The payer says they have paid; staff are checking. The hold clock is stopped. */
  PAYMENT_UNDER_VERIFICATION: 2,
  /** Paid (or free) and confirmed. The seats are theirs. */
  CONFIRMED: 3,
  /** The hold ran out. Seats released. */
  EXPIRED: 4,
  /** Called off by the booker or by staff. No refund when it was already paid. */
  CANCELLED: 5,
  /** Staff refused the request. Seats released, no invoice ever existed. */
  REJECTED: 6,
  /** The association cancelled the event and sent the money back. */
  REFUNDED: 7,
} as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUS)[keyof typeof REGISTRATION_STATUS];

/** The statuses that hold seats. Anything here counts against capacity. */
export const SEAT_HOLDING_STATUSES: number[] = [
  REGISTRATION_STATUS.PENDING_APPROVAL,
  REGISTRATION_STATUS.PENDING_PAYMENT,
  REGISTRATION_STATUS.PAYMENT_UNDER_VERIFICATION,
  REGISTRATION_STATUS.CONFIRMED,
];

export const REGISTRANT_TYPE = {
  /** A member company booking for its own people. */
  MEMBER: 0,
  /** A non-member booking for themselves. No login, ever. */
  GUEST: 1,
} as const;

export type RegistrantType = (typeof REGISTRANT_TYPE)[keyof typeof REGISTRANT_TYPE];

export const CANCELLED_BY = { MEMBER: 0, ADMIN: 1, SYSTEM: 2 } as const;

export const FOOD_PREFERENCE = { VEG: 0, NON_VEG: 1, JAIN: 2 } as const;

export const GOV_ID_TYPE = { AADHAAR: 0, PAN: 1, PASSPORT: 2, DL: 3, VOTER: 4 } as const;

export const SUBMISSION_STATUS = { PENDING: 0, VERIFIED: 1, REJECTED: 2 } as const;

export const SUBMISSION_METHOD = { NEFT: 0, UPI: 1, CHEQUE: 2, CASH: 3 } as const;

/** Fallback hold length when the setting is missing or unreadable. */
export const DEFAULT_PAYMENT_HOLD_DAYS = 5;

/** Fallback grace period when the setting is missing or unreadable. */
export const DEFAULT_GRACE_DAYS = 30;
