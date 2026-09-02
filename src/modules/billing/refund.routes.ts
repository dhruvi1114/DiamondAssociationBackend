import { Router } from 'express';

import { authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/billing/refund.controller';
import {
  completeRefundSchema,
  listRefundsSchema,
  refundReasonSchema,
} from '@modules/billing/refund.types';
import { idParamSchema } from '@modules/member/member.types';

/**
 * `/api/v1/admin/refunds` — the refund queue (A-5).
 *
 * Every route needs `refund.manage`, which only ACCOUNTS and SUPER_ADMIN hold.
 * An ADMIN can cancel an event and so raise a refund, and cannot come here to
 * release it: the separation between asking for money to go out and sending it
 * is made by the roles, not by a rule inside the module.
 */
export const refundRouter = Router();

refundRouter.use(authenticateAdmin);

refundRouter.get(
  '/refunds',
  authorize('refund.manage'),
  validateRequest({ query: listRefundsSchema }),
  controller.listRefunds,
);

refundRouter.post(
  '/refunds/:id/approve',
  authorize('refund.manage'),
  validateRequest({ params: idParamSchema }),
  controller.approveRefund,
);

refundRouter.post(
  '/refunds/:id/reject',
  authorize('refund.manage'),
  validateRequest({ params: idParamSchema, body: refundReasonSchema }),
  controller.rejectRefund,
);

refundRouter.post(
  '/refunds/:id/complete',
  authorize('refund.manage'),
  validateRequest({ params: idParamSchema, body: completeRefundSchema }),
  controller.completeRefund,
);

refundRouter.post(
  '/refunds/:id/fail',
  authorize('refund.manage'),
  validateRequest({ params: idParamSchema, body: refundReasonSchema }),
  controller.failRefund,
);
