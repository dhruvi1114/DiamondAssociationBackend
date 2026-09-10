import jwt from 'jsonwebtoken';
import { environment } from '@config/config';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { AppError } from '@utils/appError';

/**
 * A 30-minute pass to read one email address's bookings (D-6).
 *
 * A signed JWT rather than a stored opaque token: it expires before anyone could
 * act on a revocation, so a table and a migration would buy nothing.
 *
 * Kept out of `utils/jwt.ts` on purpose. Everything there is an AUDIENCE token, and
 * `authenticate` accepts those. This must never satisfy `authenticate` — it proves
 * only that somebody read one inbox, which is nothing like being signed in. The
 * explicit `scope` claim, checked on the way back in, is what keeps a member token
 * from working here and this from working anywhere else.
 */

const SCOPE = 'booking_lookup';
const TTL_SECONDS = 30 * 60;

interface LookupClaims {
  scope: string;
  email: string;
}

export const signBookingLookupToken = (email: string): string =>
  jwt.sign({ scope: SCOPE, email }, environment.jwtSecret, { expiresIn: TTL_SECONDS });

export const verifyBookingLookupToken = (token: string): string => {
  const invalid = (): AppError =>
    new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.invalidToken' });

  let claims: LookupClaims;

  try {
    claims = jwt.verify(token, environment.jwtSecret) as LookupClaims;
  } catch {
    throw invalid();
  }

  if (claims.scope !== SCOPE || typeof claims.email !== 'string' || !claims.email) {
    throw invalid();
  }

  return claims.email;
};
