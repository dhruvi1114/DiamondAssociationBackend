import { Router } from 'express';
import { authenticateAdmin, authorize } from '@middleware';
import * as controller from '@modules/dashboard/dashboard.controller';

/**
 * `/api/v1/admin/dashboard` — the admin landing page's counts (A-02, AJ-1).
 *
 * `dashboard.view` is held by all four roles, because everybody lands here. What
 * differs is WHICH tiles come back, and that is decided per-permission inside
 * the service rather than by a second guard here: one place decides what an
 * admin may be told.
 *
 * Guards bound to the path rather than router-wide, like every other router on
 * the shared `/admin` mount.
 */
export const dashboardRouter = Router();

const DASHBOARD = '/dashboard';

dashboardRouter.get(
  `${DASHBOARD}/summary`,
  authenticateAdmin,
  authorize('dashboard.view'),
  controller.getSummary,
);
