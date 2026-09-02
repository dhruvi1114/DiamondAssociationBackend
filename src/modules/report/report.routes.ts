import { Router } from 'express';
import { authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/report/report.controller';
import {
  generateReportSchema,
  generatedIdParamSchema,
  listGeneratedSchema,
} from '@modules/report/report.types';

/**
 * `/api/v1/admin/reports` — the four reports (AJ-10, screen A-29).
 *
 * A report here is a **saved record**, not a live query: it is generated once,
 * kept with the filters that produced it, and downloadable again months later.
 *
 * **Three permissions, not one.** `report.view` reads the list, `report.create`
 * runs a new one, and `report.export` takes the data out of the building. They
 * are separate because they are different risks: reading a member list on
 * screen is the job, and downloading every member's company, city and status
 * into a file that can be forwarded is a different decision. All three are
 * granted to the same roles today; the point is that they can be separated
 * without a code change.
 *
 * Guards are bound per path rather than `router.use(...)` router-wide: this
 * router shares the `/admin` mount with masters, RBAC, settings and audit, and
 * a blanket guard would 403 a request that belongs to one of them.
 */
export const reportRouter = Router();

const REPORTS = '/reports';

reportRouter.post(
  REPORTS,
  authenticateAdmin,
  authorize('report.create'),
  validateRequest({ body: generateReportSchema }),
  controller.generateReport,
);

reportRouter.get(
  REPORTS,
  authenticateAdmin,
  authorize('report.view'),
  validateRequest({ query: listGeneratedSchema }),
  controller.listReports,
);

/**
 * Declared before `/:id`. Express matches in order, and the parameterised route
 * would otherwise swallow this one — the bug that once made
 * `/applications/workflow` disappear behind `/applications/:id`.
 */
reportRouter.get(
  `${REPORTS}/:id/export`,
  authenticateAdmin,
  authorize('report.export'),
  validateRequest({ params: generatedIdParamSchema }),
  controller.exportReport,
);

reportRouter.get(
  `${REPORTS}/:id`,
  authenticateAdmin,
  authorize('report.view'),
  validateRequest({ params: generatedIdParamSchema }),
  controller.getReport,
);
