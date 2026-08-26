/**
 * Authentication policy constants (`docs/rbac.md` §1, `docs/security.md` §3).
 *
 * These numbers are a frozen contract for M1 (module file "Contracts frozen"),
 * so they live in one place rather than as literals scattered through the
 * service. Changing one is a deliberate act with an approval-checklist line
 * against it, not an edit inside a function.
 */

/** JWT `aud` claim. A member token on an admin route fails here, before any
 *  permission lookup (ADR-002). The two values are deliberately unrelated
 *  strings so a typo cannot silently widen access. */
export const TOKEN_AUDIENCES = {
  MEMBER: 'member',
  ADMIN: 'admin',
} as const;

export type TokenAudienceClaim = (typeof TOKEN_AUDIENCES)[keyof typeof TOKEN_AUDIENCES];

/** bcrypt work factor for every password and every OTP in the system. */
export const BCRYPT_COST = 12;

/** Password policy. Members ≥8 with a letter and a digit; staff ≥12. */
export const PASSWORD_POLICY = {
  MEMBER_MIN_LENGTH: 8,
  ADMIN_MIN_LENGTH: 12,
  /** At least one letter and at least one digit, any order, no other rule. */
  PATTERN: /^(?=.*[A-Za-z])(?=.*\d).+$/,
} as const;

/** Lockout: 5 consecutive failures bar sign-in for 15 minutes. */
export const LOCKOUT = {
  MAX_FAILED_ATTEMPTS: 5,
  DURATION_MINUTES: 15,
} as const;

/** Signup / verification codes. */
export const OTP = {
  LENGTH: 6,
  EXPIRY_MINUTES: 10,
  /** Wrong guesses before the code is retired and a new one must be requested. */
  MAX_ATTEMPTS: 5,
} as const;

/** Emailed password-reset links. */
export const PASSWORD_RESET = {
  EXPIRY_MINUTES: 60,
  /** Bytes of entropy in the opaque token — 32 bytes = 256 bits. */
  TOKEN_BYTES: 32,
} as const;

/** Opaque refresh tokens. Never a JWT: the point is that they are revocable. */
export const REFRESH_TOKEN = {
  TOKEN_BYTES: 48,
} as const;

/**
 * How long a re-read permission set is trusted before the database is consulted
 * again (rbac.md §1). The guarantee this buys: a permission revoked in the
 * database takes effect within 60 seconds **without the admin re-logging in**,
 * because the middleware never trusts the `perms` claim in the token.
 */
export const PERMISSION_CACHE_TTL_MS = 60_000;

/** Longest user-agent string kept on a session row. */
export const MAX_USER_AGENT_LENGTH = 512;
