import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ACTOR_TYPES } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { MSG_KEYS } from '@constant/message.constant';
import { logger } from '@logger/logger';
import { getAdminAccess, evaluate } from '@modules/rbac/rbac.cache';
import { AppError } from '@utils/appError';

/**
 * Permission guards (rbac.md §2).
 *
 *   authorize('application.approve')
 *   authorize.any('invoice.manage', 'payment.record')
 *   authorize.all('member.manage', 'member.status')
 *
 * Always mounted AFTER `authenticateAdmin`, which has already rejected a member
 * token on `aud` — so by the time this runs, the actor is provably staff and the
 * only remaining question is what they may do.
 *
 * The permission set is re-read (through the 60-second cache) rather than taken
 * from `req.actor`. `authenticateAdmin` populated `req.actor.permissions` from
 * the same source a moment ago, so in practice this is the same cached object;
 * reading it again here means the guard is correct even if some future
 * middleware mounts it on its own, and it is where the super-admin bypass gets
 * recorded.
 *
 * A super admin passes every check (`is_super_admin`), and every such bypass is
 * logged — rbac.md §2 requires the bypass to be auditable, and a bypass nobody
 * can see is indistinguishable from a missing check.
 */

const forbidden = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey: MSG_KEYS.FORBIDDEN });

const guard =
  (required: string[], mode: 'any' | 'all'): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        if (req.actor?.type !== ACTOR_TYPES.ADMIN || req.actor.id === undefined) {
          // Reaching here means the route was wired without `authenticateAdmin`.
          // Failing closed with a 401 is the only safe answer, and the log line
          // names the route so the miswiring is found rather than worked around.
          logger.error('rbac.guardWithoutAuthentication', {
            method: req.method,
            url: req.originalUrl,
            required,
          });

          throw new AppError({
            errorType: ERROR_TYPES.UNAUTHORIZED,
            messageKey: 'auth.unauthorized',
          });
        }

        const access = await getAdminAccess(req.actor.id);

        if (!access) {
          throw new AppError({
            errorType: ERROR_TYPES.UNAUTHORIZED,
            messageKey: 'auth.invalidToken',
          });
        }

        const { granted, viaSuperAdmin } = evaluate(access, required, mode);

        if (!granted) {
          logger.warn('rbac.denied', {
            adminUserId: access.id.toString(),
            required,
            mode,
            method: req.method,
            url: req.originalUrl,
          });

          throw forbidden();
        }

        if (viaSuperAdmin) {
          logger.info('rbac.superAdminBypass', {
            adminUserId: access.id.toString(),
            required,
            method: req.method,
            url: req.originalUrl,
          });
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };

interface Authorize {
  (permission: string): RequestHandler;
  /** Holds at least one of these. */
  any: (...permissions: string[]) => RequestHandler;
  /** Holds every one of these. */
  all: (...permissions: string[]) => RequestHandler;
}

export const authorize: Authorize = Object.assign(
  (permission: string): RequestHandler => guard([permission], 'all'),
  {
    any: (...permissions: string[]): RequestHandler => guard(permissions, 'any'),
    all: (...permissions: string[]): RequestHandler => guard(permissions, 'all'),
  },
);

/** The role code that carries super-admin authority (rbac.md §3, seeded). */
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

/**
 * Super admins only — for the operations no ordinary role may reach because
 * granting them would BE the escalation (rbac.md §3: RBAC, templates, workflow
 * and settings are SUPER_ADMIN's alone).
 *
 * Accepts EITHER the `is_super_admin` flag OR the SUPER_ADMIN role. Both are
 * routes to the same authority (rbac.md §2 gives the flag a blanket bypass; §3
 * gives the role every permission), and `countActiveSuperAdmins` already counts
 * both when deciding whether the last one is being removed.
 *
 * Checking only the flag would have made the platform unable to have a second
 * super admin: the flag is deliberately not settable through the API (see
 * `rbac.service.createAdminUser`), so granting the role is the only supported
 * way to promote a colleague — and that colleague would then have been locked
 * out of the very screens the role exists for.
 *
 * Used together with `authorize('rbac.manage')`, not instead of it: the
 * permission states the intent and appears in the matrix screen; this is the
 * hard floor that survives someone granting `rbac.manage` to another role.
 */
export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  const isSuperAdmin =
    Boolean(req.actor?.isSuperAdmin) || Boolean(req.actor?.roles?.includes(SUPER_ADMIN_ROLE));

  if (!isSuperAdmin) {
    logger.warn('rbac.superAdminRequired', {
      adminUserId: req.actor?.id?.toString(),
      method: req.method,
      url: req.originalUrl,
    });

    next(forbidden());
    return;
  }

  next();
};
