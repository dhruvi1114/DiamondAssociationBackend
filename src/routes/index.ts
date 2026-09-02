import { Router } from 'express';
import { environment } from '@config/config';
import { END_POINTS } from '@constant';
import { logger } from '@logger/logger';
import { authRouter } from '@modules/auth/auth.routes';
import { applicationAdminRouter, applicationRouter } from '@modules/application/application.routes';
import {
  applicationPublicRouter,
  applicationSuperAdminRouter,
} from '@modules/application/public.routes';
import { refundRouter } from '@modules/billing/refund.routes';
import { directoryRouter } from '@modules/directory/directory.routes';
import {
  eventAdminRouter,
  eventMemberRouter,
  eventPublicRouter,
} from '@modules/event/event.routes';
import { mastersAdminRouter, mastersPublicRouter } from '@modules/masters/masters.routes';
import { newsAdminRouter, newsMemberRouter, newsPublicRouter } from '@modules/news/news.routes';
import {
  documentRouter,
  invoiceRouter,
  memberAdminRouter,
  memberPublicRouter,
  memberRouter,
} from '@modules/member/member.routes';
import { rbacRouter } from '@modules/rbac/rbac.routes';
import { sitePublicRouter } from '@modules/site/site.routes';
import {
  brandingPublicRouter,
  settingsPublicRouter,
  settingsRouter,
} from '@modules/settings/settings.routes';
import { healthRouter } from '@routes/health/health.routes';
import { selfTestRouter } from '@routes/selftest/selftest.routes';

export const router = Router();

/**
 * `/api/v1` router. M0 mounted infrastructure only — health, plus a local-only
 * self-test reflector. Each cycle mounts its own module router here:
 *   M1 auth + rbac · M2 masters · M3 members · M4 applications · M5 payments …
 */
router.use(`${END_POINTS.V1}${END_POINTS.HEALTH}`, healthRouter);

// M1 — both audiences live under /auth; staff administration under /admin.
router.use(`${END_POINTS.V1}${END_POINTS.AUTH}`, authRouter);
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, rbacRouter);
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, settingsRouter);
// The logo and logo mark, unauthenticated — the login screen and the invoice
// header both need them and neither has a session. Only those two images are
// reachable; see `branding.service.ts`.
router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, brandingPublicRouter);
// The `is_public` settings — the display name the browser tab and the sign-in
// screen are named after. Read-only; the allow-list is the `is_public` column.
router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, settingsPublicRouter);

// The public homepage's member/country counts. No session, no member data —
// aggregate figures only. The company-name wall this once fed was disabled on
// 2026-08-31 by decision D1; a count discloses nothing about any one company.
router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, sitePublicRouter);
// The member's own company logo. The router is empty as of 2026-08-31 (D1): the
// member directory is members-only, so no member logo is served unauthenticated.
// The mount stays so restoring the route is a one-line uncomment in member.routes.ts.
router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, memberPublicRouter);

// M2 — membership catalogue. Admin writes are permission-gated per rbac.md §3;
// the public router exposes only the published, allowlisted subset (C-03).
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, mastersAdminRouter);
router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, mastersPublicRouter);

// M3 — the member record, KYC documents and staff member management.
router.use(`${END_POINTS.V1}${END_POINTS.MEMBERS}`, memberRouter);
router.use(`${END_POINTS.V1}${END_POINTS.DOCUMENTS}`, documentRouter);
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, memberAdminRouter);

router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, eventAdminRouter);

router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, eventPublicRouter);

router.use(`${END_POINTS.V1}${END_POINTS.EVENTS}`, eventMemberRouter);

// M9 — news: the association's own writing on the public website. Three
// audiences, one set of readers: the public router never authenticates, so the
// repository's public filter is what a logged-out visitor gets; the member
// router adds the member-only articles on top of the same list.
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, newsAdminRouter);
router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, newsPublicRouter);
router.use(`${END_POINTS.V1}${END_POINTS.NEWS}`, newsMemberRouter);

// M9 — the member directory. Members-only by decision D1: one router, a member
// token required, and the ACTIVE-membership check inside the module. There is
// deliberately no public sibling — an anonymous caller has no endpoint here.
router.use(`${END_POINTS.V1}${END_POINTS.DIRECTORY}`, directoryRouter);

// M5 — invoice and receipt PDFs, both audiences.
router.use(`${END_POINTS.V1}${END_POINTS.INVOICES}`, invoiceRouter);

// The refund queue lives with the other staff billing screens.
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, refundRouter);

// M4 — applications, the approval workflow and activation.
router.use(`${END_POINTS.V1}${END_POINTS.APPLICATIONS}`, applicationRouter);
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, applicationAdminRouter);
// The login-free correction link (reject-resubmit spec D-9). Unauthenticated on
// purpose: a rejected applicant has no account and no password, so there is
// nothing for them to sign in to. The token in the path is the whole authority.
router.use(`${END_POINTS.V1}${END_POINTS.PUBLIC}`, applicationPublicRouter);
// Clearing an application's resubmission counter — super admin only (D-13).
router.use(`${END_POINTS.V1}${END_POINTS.ADMIN}`, applicationSuperAdminRouter);

if (environment.isLocal) {
  router.use(`${END_POINTS.V1}/_selftest`, selfTestRouter);
  logger.warn('routes.selfTestMounted', {
    note: 'Local-only encryption round-trip endpoint. Never reachable outside APP_ENV=local.',
  });
}

export default router;
