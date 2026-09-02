import { z } from 'zod';

import { REFUND_STATUS } from '@modules/billing/payment.constants';

/**
 * Query for `GET /admin/refunds`.
 *
 * `status` is the whole filter set. A refund is only ever looked for by where it
 * has got to — "what is waiting on me" and "what have we already sent" are the
 * two questions this queue answers, and both are a status.
 */
export const listRefundsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /**
   * Matches the refund number, the invoice number, or the payer's name.
   *
   * Those three are what somebody has in front of them when they come looking:
   * an email quoting RF…, an invoice on a bank statement, or a member on the
   * phone. Nothing else is searched, so the screen can mark exactly the cells
   * the server matched on.
   */
  search: z.string().trim().min(1).max(100).optional(),
  status: z.coerce
    .number()
    .int()
    .refine(
      (value) => Object.values(REFUND_STATUS).includes(value as never),
      'Unknown refund status',
    )
    .optional(),
});

export type ListRefundsQuery = z.infer<typeof listRefundsSchema>;

/**
 * Body of `POST /admin/refunds/:id/reject` and `/fail`.
 *
 * The reason is required in both. A refused or bounced refund is money the
 * payer was told to expect and will not get yet, and "rejected" with no reason
 * is the message that generates the phone call this field exists to prevent.
 */
export const refundReasonSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type RefundReasonInput = z.infer<typeof refundReasonSchema>;

/**
 * Body of `POST /admin/refunds/:id/complete`.
 *
 * The bank reference is mandatory. "Completed" without one is a claim that
 * cannot be checked against a statement, which is exactly the check this record
 * exists to survive.
 */
export const completeRefundSchema = z.object({
  reference: z.string().trim().min(3).max(100),
});

export type CompleteRefundInput = z.infer<typeof completeRefundSchema>;
