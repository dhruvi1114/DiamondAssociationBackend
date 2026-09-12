import { Router } from 'express';
import { authenticate, authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/renewal/renewal.controller';
import { bucketListSchema, switchPlanSchema } from '@modules/renewal/renewal.types';

/** `/api/v1/admin/renewals` — A-20. Guards bound per path, like every router on the /admin mount. */
export const renewalAdminRouter = Router();
const RENEWALS = '/renewals';

renewalAdminRouter.get(
  `${RENEWALS}/summary`,
  authenticateAdmin,
  authorize('renewal.view'),
  controller.getAdminSummary,
);
renewalAdminRouter.get(
  RENEWALS,
  authenticateAdmin,
  authorize('renewal.view'),
  validateRequest({ query: bucketListSchema }),
  controller.listAdminBucket,
);
renewalAdminRouter.post(
  `${RENEWALS}/run`,
  authenticateAdmin,
  authorize('renewal.manage'),
  controller.runAdminCycle,
);

/**
 * `/api/v1/membership/me/*` — the member's own term (C-18, C-23).
 *
 * Handlers are stubs (`throw new Error('not implemented')`) until Task 11; this
 * router only needs to compile and mount so the admin router above is reachable.
 */
export const renewalMemberRouter = Router();
renewalMemberRouter.use(authenticate);
renewalMemberRouter.get('/me/term', controller.getMyTerm);
renewalMemberRouter.get('/me/terms', controller.listMyTerms);
renewalMemberRouter.get('/me/renewal/plans', controller.listMyRenewalPlans);
renewalMemberRouter.post(
  '/me/renewal/plan',
  validateRequest({ body: switchPlanSchema }),
  controller.switchMyRenewalPlan,
);
renewalMemberRouter.post('/me/renewal/decline', controller.declineMyRenewal);
renewalMemberRouter.post('/me/renewal/resume', controller.resumeMyRenewal);
