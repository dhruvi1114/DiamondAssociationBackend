import { Router } from 'express';
import multer from 'multer';

import { authenticateAdmin, authorize, requireSuperAdmin, validateRequest } from '@middleware';
import * as controller from '@modules/settings/settings.controller';
import { updateSettingsSchema } from '@modules/settings/settings.types';

/**
 * `/api/v1/admin/settings` — runtime configuration (AJ-10, screen A-34).
 *
 * Guarded three ways, in this order and for the same reason `rbac.routes.ts`
 * spells out: `authorize('settings.manage')` is the code the matrix and the nav
 * agree on, `requireSuperAdmin` is the floor that survives someone granting that
 * code to another role by mistake. These settings decide whether member data is
 * public and what goes on a tax invoice, so the floor is worth having.
 *
 * Scoped with a path prefix rather than `router.use(...)` router-wide: this
 * router shares the `/admin` mount with masters and RBAC, and a blanket guard
 * would 403 an ACCOUNTS admin on routes this file does not own.
 */
export const settingsRouter = Router();

const SETTINGS = '/settings';
const superAdminOnly = [authenticateAdmin, authorize('settings.manage'), requireSuperAdmin];

settingsRouter.use(SETTINGS, ...superAdminOnly);

settingsRouter.get(SETTINGS, controller.listSettings);

/**
 * PATCH, not PUT, and a batch rather than one call per field: the screen commits
 * everything the admin changed in one press, and a per-field endpoint would make
 * "some of my changes saved" the normal outcome of a dropped connection.
 */
settingsRouter.patch(
  SETTINGS,
  validateRequest({ body: updateSettingsSchema }),
  controller.updateSettings,
);

/**
 * In memory, like every other upload here: the bytes are sniffed before anything
 * touches the filesystem. 2 MB is the hard stop and the branding service applies
 * the same limit again — this one only stops a large body being buffered at all.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

const BRANDING = `${SETTINGS}/branding/:slot`;

settingsRouter.post(BRANDING, ...superAdminOnly, upload.single('file'), controller.uploadBranding);
settingsRouter.delete(BRANDING, ...superAdminOnly, controller.removeBranding);

/**
 * `/api/v1/public/branding/:slot` — the logo and the logo mark, unauthenticated.
 *
 * A separate router because it must NOT inherit the guards above. The login page
 * and an invoice PDF both need the logo and neither has a session; the safety
 * comes from the two-entry slot map in `branding.service.ts`, not from a token.
 * Nothing else in this module is public, and nothing else should be added here.
 */
export const brandingPublicRouter = Router();

brandingPublicRouter.get('/branding/:slot', controller.serveBranding);

/**
 * `/api/v1/public/settings` — the `is_public` rows, unauthenticated.
 *
 * Its own router for the same reason the branding one is: it must not inherit
 * the super-admin guards above. The admin shell needs the association's display
 * name for the browser tab on every screen including sign-in, and the settings
 * list proper is behind `settings.manage` — which would leave every staff member
 * but one looking at a tab named after the placeholder.
 *
 * Read-only, and the allow-list is the `is_public` column, not this file.
 */
export const settingsPublicRouter = Router();

settingsPublicRouter.get('/settings', controller.listPublicSettings);
