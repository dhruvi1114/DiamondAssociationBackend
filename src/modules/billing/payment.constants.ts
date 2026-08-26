/**
 * Integer enum codes for the money tables.
 *
 * `Payments` and `Refunds` are M7-era tables, so their enums are `smallint`
 * codes rather than Postgres native enums. Codes are append-only — a value is
 * never renumbered or reused, because rows keep whatever number was written into
 * them. The database enforces the ranges with CHECK constraints.
 */

export const PAYMENT_METHOD = {
  /** Card, netbanking or wallet through a gateway. */
  ONLINE: 0,
  /** Bank transfer. The default while there is no gateway. */
  NEFT: 1,
  CHEQUE: 2,
  CASH: 3,
  UPI: 4,
  /** A book entry, not money moving — a credit applied against a balance. */
  ADJUSTMENT: 5,
} as const;

export type PaymentMethod = (typeof PAYMENT_METHOD)[keyof typeof PAYMENT_METHOD];

export const PAYMENT_STATUS = {
  /** Created, nothing attempted yet. */
  INITIATED: 0,
  /** Money claimed but not confirmed — awaiting staff verification or a gateway callback. */
  PENDING: 1,
  /** Confirmed received. `paid_at` is required in this state and forbidden outside it. */
  SUCCESS: 2,
  FAILED: 3,
  CANCELLED: 4,
  REFUNDED: 5,
  PARTIALLY_REFUNDED: 6,
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const REFUND_STATUS = {
  REQUESTED: 0,
  PROCESSING: 1,
  COMPLETED: 2,
  FAILED: 3,
  REJECTED: 4,
} as const;

export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];

/** Provider code for a payment staff recorded by hand, per the A-5 provider interface. */
export const MANUAL_PROVIDER = 'MANUAL';
