import type { NextFunction, Request, Response } from 'express';
import { UserStatus } from '@prisma/client';
import { ACTOR_TYPES } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { findUserById } from '@modules/auth/auth.repository';
import { getAdminAccess } from '@modules/rbac/rbac.cache';
import { AppError } from '@utils/appError';
import {
  authFailureError,
  bearerToken,
  verifyAdminAccessToken,
  verifyMemberAccessToken,
} from '@utils/jwt';

/**
 * The two authentication middlewares (rbac.md §1, ADR-002).
 *
 * Order inside each is load-bearing and identical:
 *
 *   1. extract the bearer token          → 401 if absent
 *   2. verify signature + issuer + `aud` → 401 expired/tampered, 403 wrong audience
 *   3. re-read the subject from the DB   → 401 if deleted or no longer ACTIVE
 *   4. attach `req.actor`
 *
 * Step 2 is what makes "a member token on an admin route fails on `aud` before
 * any permission check" true rather than aspirational: `jwt.verify` is given the
 * expected audience, so the wrong one throws inside the library and steps 3 and
 * 4 never run. There is no code path in which a member token reaches
 * `authorize()`.
 *
 * Step 3 exists because a 30-minute token outlives an administrative decision. A
 * member suspended one minute after signing in must stop being able to act now,
 * not in 29 minutes. For staff the same read also produces the live permission
 * set (through the 60-second cache), so it is not an extra query.
 */

const missingToken = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });

const inactiveAccount = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.accountInactive' });

/** Member routes. Attaches `req.actor` with `type: MEMBER`. */
export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const token = bearerToken(req.get('authorization'));

      if (!token) {
        throw missingToken();
      }

      const { claims, failure } = verifyMemberAccessToken(token);

      if (!claims || failure) {
        throw authFailureError(failure ?? 'invalid');
      }

      const user = await findUserById(prisma, BigInt(claims.sub));

      if (!user) {
        // Deleted account holding a still-valid token. 401, not 404: there is no
        // resource being addressed here, only a session that is no longer real.
        throw new AppError({
          errorType: ERROR_TYPES.UNAUTHORIZED,
          messageKey: 'auth.invalidToken',
        });
      }

      if (user.status !== UserStatus.ACTIVE) {
        throw inactiveAccount();
      }

      req.actor = {
        type: ACTOR_TYPES.MEMBER,
        id: user.id,
        email: user.email,
      };

      next();
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Staff routes. Attaches `req.actor` with `type: ADMIN`, the LIVE permission set
 * and `isSuperAdmin` — all read from the database (cached 60 s), never from the
 * token, which carries only a hash of the set.
 */
export const authenticateAdmin = (req: Request, _res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const token = bearerToken(req.get('authorization'));

      if (!token) {
        throw missingToken();
      }

      const { claims, failure } = verifyAdminAccessToken(token);

      if (!claims || failure) {
        throw authFailureError(failure ?? 'invalid');
      }

      const access = await getAdminAccess(BigInt(claims.sub));

      if (!access) {
        throw new AppError({
          errorType: ERROR_TYPES.UNAUTHORIZED,
          messageKey: 'auth.invalidToken',
        });
      }

      if (access.status !== UserStatus.ACTIVE) {
        throw inactiveAccount();
      }

      req.actor = {
        type: ACTOR_TYPES.ADMIN,
        id: access.id,
        email: access.email,
        isSuperAdmin: access.is_super_admin,
        permissions: access.permissions,
        roles: access.roles.map((role) => role.code),
      };

      next();
    } catch (error) {
      next(error);
    }
  })();
};
