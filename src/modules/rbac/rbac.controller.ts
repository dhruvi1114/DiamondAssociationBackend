import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/rbac/rbac.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const actor = (req: Request) => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return {
    id: req.actor.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
};

export const listAdminUsers = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listAdminUsers>[0];
  const result = await service.listAdminUsers(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: result.rows,
    pagination: { page: query.page, limit: query.limit, total: result.total },
  });
});

export const getAdminUser = handler(async (req, res) => {
  const result = await service.getAdminUser(BigInt(req.params.id));

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});

export const createAdminUser = handler(async (req, res) => {
  const result = await service.createAdminUser(req.body, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'rbac.adminCreated',
    data: result,
  });
});

export const updateAdminUser = handler(async (req, res) => {
  const result = await service.updateAdminUser(BigInt(req.params.id), req.body, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'rbac.adminUpdated',
    data: result,
  });
});

export const assignRole = handler(async (req, res) => {
  const result = await service.assignRole(
    BigInt(req.params.id),
    (req.body as { role_code: string }).role_code,
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'rbac.roleAssigned',
    data: result,
  });
});

export const revokeRole = handler(async (req, res) => {
  const result = await service.revokeRole(BigInt(req.params.id), req.params.roleCode, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'rbac.roleRevoked',
    data: result,
  });
});

/** `GET /admin/permissions` — every permission the platform defines. */
export const listPermissions = handler(async (_req, res) => {
  const result = await service.listPermissions();

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});

/**
 * `PATCH /admin/roles/:roleCode/permissions` — replace a role's grants.
 *
 * The whole set, not a diff. The screen is a matrix of tick boxes, and sending
 * the state the admin is looking at cannot drift from it the way a sequence of
 * add/remove calls can.
 */
export const setRolePermissions = handler(async (req, res) => {
  const result = await service.setRolePermissions(
    req.params.roleCode as string,
    (req.body as { permission_codes: string[] }).permission_codes,
    {
      ...actor(req),
      roles: req.actor?.roles ?? [],
      isSuperAdmin: Boolean(req.actor?.isSuperAdmin),
    },
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'rbac.rolePermissionsUpdated',
    data: result,
  });
});

export const listRoles = handler(async (_req, res) => {
  const result = await service.listRoles();

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});
