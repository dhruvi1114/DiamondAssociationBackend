import crypto from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { environment } from '@config/config';
import { TOKEN_AUDIENCES, type TokenAudienceClaim } from '@constant/auth.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { AppError } from '@utils/appError';

/**
 * Access-token minting and verification for both audiences (rbac.md §1).
 *
 * Two properties this module exists to guarantee:
 *
 *  1. **`aud` is verified by the library, not by us.** `jwt.verify` is given the
 *     expected audience, so a member token presented to an admin route fails
 *     inside `verify` — before any code that could look up a permission runs
 *     (ADR-002). A hand-rolled `if (payload.aud !== 'admin')` after a successful
 *     verify would be one forgotten line away from a privilege escalation.
 *  2. **`perms` in an admin token is a hash, never the list.** The list is
 *     re-read from the database on every admin request (rbac.md §1). Embedding
 *     the codes would invite exactly the "the token said so" check the 60-second
 *     cache exists to prevent; a hash still lets a client notice its permission
 *     set changed without being able to assert what it now is.
 */

/** Claims shared by both audiences. `jti` makes a token individually traceable. */
interface BaseClaims extends JwtPayload {
  sub: string;
  aud: TokenAudienceClaim;
  jti: string;
}

/** Member access token (rbac.md §1). */
export interface MemberTokenClaims extends BaseClaims {
  aud: typeof TOKEN_AUDIENCES.MEMBER;
  /**
   * `Members.id` once the membership record exists (M3). Null for every token
   * M1 can issue — the claim is present from the start so M3 fills a field
   * rather than changing the token shape, which is a frozen contract.
   */
  member_id: string | null;
  /** Account status at issue time. Re-checked against the row on every request. */
  status: string;
}

/** Staff access token (rbac.md §1). */
export interface AdminTokenClaims extends BaseClaims {
  aud: typeof TOKEN_AUDIENCES.ADMIN;
  roles: string[];
  /** SHA-256 of the sorted permission codes — a change detector, not a grant. */
  perms_hash: string;
  is_super_admin: boolean;
}

export type AccessTokenClaims = MemberTokenClaims | AdminTokenClaims;

/** Issuer string, so a token minted for another deployment fails verification. */
const ISSUER = 'association-platform';

const signOptions = (audience: TokenAudienceClaim): SignOptions => ({
  audience,
  issuer: ISSUER,
  expiresIn: environment.jwtAccessExpiresIn as SignOptions['expiresIn'],
  jwtid: crypto.randomUUID(),
});

/**
 * Stable fingerprint of a permission set. Sorted first so that two admins with
 * the same permissions in a different order produce the same hash, and so a
 * re-seed that reorders grants does not look like a permission change.
 */
export const hashPermissions = (codes: string[]): string =>
  crypto
    .createHash('sha256')
    .update([...codes].sort().join(','))
    .digest('hex')
    .slice(0, 32);

export interface MemberTokenInput {
  userId: bigint;
  status: string;
  memberId?: bigint | null;
}

export const signMemberAccessToken = (input: MemberTokenInput): string =>
  jwt.sign(
    {
      member_id: input.memberId ? input.memberId.toString() : null,
      status: input.status,
    },
    environment.jwtSecret,
    { ...signOptions(TOKEN_AUDIENCES.MEMBER), subject: input.userId.toString() },
  );

export interface AdminTokenInput {
  adminUserId: bigint;
  roles: string[];
  permissions: string[];
  isSuperAdmin: boolean;
}

export const signAdminAccessToken = (input: AdminTokenInput): string =>
  jwt.sign(
    {
      roles: input.roles,
      perms_hash: hashPermissions(input.permissions),
      is_super_admin: input.isSuperAdmin,
    },
    environment.jwtSecret,
    { ...signOptions(TOKEN_AUDIENCES.ADMIN), subject: input.adminUserId.toString() },
  );

/**
 * Verify an access token against ONE expected audience.
 *
 * Every failure — expired, tampered signature, wrong issuer, wrong audience —
 * surfaces as 401 `UNAUTHORIZED` with an i18n key the client can act on, and
 * never as a 500. The distinction the caller is allowed to see is only
 * "expired" vs "invalid", because that changes what the UI does next (refresh
 * silently vs sign out).
 *
 * Note the audience mismatch also answers 401 rather than 403: at this point
 * nothing is authenticated yet, so there is no "authenticated but not allowed"
 * to report. The 403 the wrong-audience case must produce is raised one layer
 * up, in `authenticate*`, where it can distinguish "no token" from "a valid
 * token for the other side of the house" (api-conventions.md §5).
 */
export type VerifyFailure = 'expired' | 'invalid' | 'wrong-audience';

export interface VerifyResult<T> {
  claims?: T;
  failure?: VerifyFailure;
}

const verifyAccessToken = <T extends AccessTokenClaims>(
  token: string,
  audience: TokenAudienceClaim,
): VerifyResult<T> => {
  try {
    return {
      claims: jwt.verify(token, environment.jwtSecret, {
        audience,
        issuer: ISSUER,
        algorithms: ['HS256'],
      }) as T,
    };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { failure: 'expired' };
    }

    // jsonwebtoken reports an audience mismatch as a JsonWebTokenError whose
    // message begins "jwt audience invalid". Distinguishing it lets the caller
    // answer 403 for a real token aimed at the wrong audience and 401 for
    // rubbish, which is the split api-conventions.md §5 asks for.
    if (error instanceof jwt.JsonWebTokenError && error.message.includes('audience invalid')) {
      return { failure: 'wrong-audience' };
    }

    return { failure: 'invalid' };
  }
};

export const verifyMemberAccessToken = (token: string): VerifyResult<MemberTokenClaims> =>
  verifyAccessToken<MemberTokenClaims>(token, TOKEN_AUDIENCES.MEMBER);

export const verifyAdminAccessToken = (token: string): VerifyResult<AdminTokenClaims> =>
  verifyAccessToken<AdminTokenClaims>(token, TOKEN_AUDIENCES.ADMIN);

/** `Authorization: Bearer <jwt>` → the token, or undefined. */
export const bearerToken = (header?: string): string | undefined => {
  if (!header) {
    return undefined;
  }

  const [scheme, value] = header.split(' ');

  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : undefined;
};

/** Maps a verification failure to the error the middleware should throw. */
export const authFailureError = (failure: VerifyFailure): AppError =>
  failure === 'wrong-audience'
    ? new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey: 'auth.wrongAudience' })
    : new AppError({
        errorType: ERROR_TYPES.UNAUTHORIZED,
        messageKey: failure === 'expired' ? 'auth.sessionExpired' : 'auth.invalidToken',
      });
