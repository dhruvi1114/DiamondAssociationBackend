import { Router } from 'express';
import { authenticateAdmin, authorize, requireSuperAdmin, validateRequest } from '@middleware';
import * as controller from '@modules/rbac/rbac.controller';
import {
  adminUserIdParamSchema,
  adminUserRoleParamsSchema,
  assignRoleSchema,
  createAdminUserSchema,
  listAdminUsersSchema,
  roleCodeParamSchema,
  setRolePermissionsSchema,
  updateAdminUserSchema,
} from '@modules/rbac/rbac.types';

/**
 * `/api/v1/admin` — staff accounts and role assignment (AJ-9, screens A-31/A-32).
 *
 * Every route carries the same three-part guard, in this order:
 *   authenticateAdmin  → is this a staff session at all (checks `aud` first)
 *   authorize('rbac.manage') → does the role grant RBAC administration
 *   requireSuperAdmin  → and is this actually a super admin
 *
 * The last two are not redundant. `rbac.manage` is the code that appears in the
 * matrix and the one the UI gates the nav item on; `requireSuperAdmin` is the
 * hard floor that survives someone granting `rbac.manage` to another role by
 * mistake — which is precisely the mistake an RBAC screen makes possible.
 *
 * `GET /admin/roles` is read-only and delivered here rather than in M10 because
 * assigning a role is unusable without a list of roles to assign. The role
 * *editor* (A-31) remains M10.
 */
export const rbacRouter = Router();

/**
 * Scoped to this router's own path prefixes, NOT applied router-wide.
 *
 * `rbacRouter.use(guards)` looks equivalent and is not: a router-level `use` runs
 * for every request that reaches the mount point, before Express has decided
 * whether any route here matches. Since this router and the M2 masters router are
 * both mounted on `/admin`, the blanket form rejected an ACCOUNTS admin calling
 * `/admin/fee-structures` — a route this file does not own — with a 403 for
 * `rbac.manage`. Binding the guards to `/roles` and `/admin-users` keeps them
 * where they belong and makes the mount order irrelevant.
 */
const superAdminOnly = [authenticateAdmin, authorize('rbac.manage'), requireSuperAdmin];

rbacRouter.use('/roles', ...superAdminOnly);
rbacRouter.use('/admin-users', ...superAdminOnly);

rbacRouter.get('/roles', controller.listRoles);

/**
 * The permission editor (M10, screen A-31).
 *
 * Behind the same three-part guard as everything else here, and deliberately so:
 * this is the endpoint that can widen any role, so granting it to anyone but a
 * super admin would BE the escalation it exists to control.
 */
rbacRouter.use('/permissions', ...superAdminOnly);

rbacRouter.get('/permissions', controller.listPermissions);

rbacRouter.patch(
  '/roles/:roleCode/permissions',
  validateRequest({ params: roleCodeParamSchema, body: setRolePermissionsSchema }),
  controller.setRolePermissions,
);

rbacRouter.get(
  '/admin-users',
  validateRequest({ query: listAdminUsersSchema }),
  controller.listAdminUsers,
);

rbacRouter.post(
  '/admin-users',
  validateRequest({ body: createAdminUserSchema }),
  controller.createAdminUser,
);

rbacRouter.get(
  '/admin-users/:id',
  validateRequest({ params: adminUserIdParamSchema }),
  controller.getAdminUser,
);

rbacRouter.patch(
  '/admin-users/:id',
  validateRequest({ params: adminUserIdParamSchema, body: updateAdminUserSchema }),
  controller.updateAdminUser,
);

rbacRouter.post(
  '/admin-users/:id/roles',
  validateRequest({ params: adminUserIdParamSchema, body: assignRoleSchema }),
  controller.assignRole,
);

rbacRouter.delete(
  '/admin-users/:id/roles/:roleCode',
  validateRequest({ params: adminUserRoleParamsSchema }),
  controller.revokeRole,
);
