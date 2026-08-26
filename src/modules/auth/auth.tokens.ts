import crypto from 'node:crypto';
import { environment } from '@config/config';
import { PASSWORD_RESET, REFRESH_TOKEN } from '@constant/auth.constant';

/**
 * Opaque credentials: refresh tokens and password-reset tokens.
 *
 * Both are random bytes, not JWTs, and the database stores only a keyed hash.
 * Three consequences worth stating, because each is the reason for a line here:
 *
 *  - **Opaque, so revocable.** A JWT is valid until it expires no matter what the
 *    server thinks; a random string is valid only while a row says so, which is
 *    what makes logout and logout-all mean anything (rbac.md §1).
 *  - **Hashed, so a database leak is not a session leak.** `AuthTokens` read
 *    access alone yields nothing usable.
 *  - **HMAC, not a bare SHA-256.** These tokens have no user-chosen entropy to
 *    protect, so a plain digest would be adequate against guessing — but keying
 *    the digest with `JWT_REFRESH_SECRET` means an attacker who exfiltrates the
 *    table still cannot verify a candidate token offline without also having the
 *    application secret. One line of cost, one extra thing an attacker needs.
 */

/** URL-safe random string. base64url so it survives an email link untouched. */
const randomToken = (bytes: number): string => crypto.randomBytes(bytes).toString('base64url');

/**
 * Keyed digest of an opaque token. `timingSafeEqual` is not needed on the
 * lookup: we search BY the hash, so the comparison happens inside Postgres on a
 * unique index rather than in JavaScript against a secret.
 */
export const hashOpaqueToken = (token: string): string =>
  crypto.createHmac('sha256', environment.jwtRefreshSecret).update(token).digest('hex');

export const generateRefreshToken = (): string => randomToken(REFRESH_TOKEN.TOKEN_BYTES);

export const generatePasswordResetToken = (): string => randomToken(PASSWORD_RESET.TOKEN_BYTES);

/** Numeric OTP, zero-padded, drawn from the CSPRNG rather than `Math.random`. */
export const generateOtpCode = (length: number): string => {
  const max = 10 ** length;
  // Rejection-free: reading a full 32-bit word and reducing it mod 10^6 biases
  // the low codes by ~1 in 4000, which is irrelevant here, but randomInt does
  // the rejection sampling for free so there is no reason to accept even that.
  return crypto.randomInt(0, max).toString().padStart(length, '0');
};

/**
 * `30m` / `7d` / `900s` → milliseconds.
 *
 * Written out rather than pulling in `ms`: the env values are ours, the grammar
 * is four suffixes, and a config value that silently parses to NaN would set an
 * expiry of `Invalid Date` — so this throws instead, at startup, on the first
 * token issued.
 */
const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export const durationToMs = (value: string): number => {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());

  if (!match) {
    throw new Error(
      `Unsupported duration "${value}". Use <number><s|m|h|d>, e.g. 30m, 7d (config.ts).`,
    );
  }

  return Number(match[1]) * DURATION_UNITS[match[2]];
};

export const memberRefreshExpiresAt = (): Date =>
  new Date(Date.now() + durationToMs(environment.jwtRefreshExpiresIn));

export const adminRefreshExpiresAt = (): Date =>
  new Date(Date.now() + durationToMs(environment.jwtAdminRefreshExpiresIn));

/** Seconds of life in an access token, for the `expiresIn` field of a login response. */
export const accessTokenLifetimeSeconds = (): number =>
  Math.floor(durationToMs(environment.jwtAccessExpiresIn) / 1000);
