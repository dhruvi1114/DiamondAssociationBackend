import { OtpPurpose, TokenAudience, UserStatus, type Prisma } from '@prisma/client';
import { MAX_USER_AGENT_LENGTH } from '@constant/auth.constant';
import type { Db } from '@db/prisma';

/**
 * Data access for the auth module.
 *
 * Every function takes `db` first so it can join the caller's transaction —
 * "issue a code and queue its email atomically" is only true if both statements
 * run on the same client (ADR-010, RULES.md).
 *
 * Two rules applied without exception here:
 *  - every read of a soft-deleted table filters `deletedAt: null`;
 *  - `password_hash` is selected only where a comparison genuinely needs it, so
 *    a careless spread in a service cannot leak it into a response.
 */

/** The columns a session response is allowed to contain. No hash, ever. */
const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  full_name: true,
  phone: true,
  status: true,
  email_verified_at: true,
  last_login_at: true,
} satisfies Prisma.UserSelect;

const ADMIN_PUBLIC_SELECT = {
  id: true,
  email: true,
  full_name: true,
  phone: true,
  status: true,
  is_super_admin: true,
  last_login_at: true,
} satisfies Prisma.AdminUserSelect;

/** The same columns plus the credential fields the login path must compare. */
const USER_CREDENTIAL_SELECT = {
  ...USER_PUBLIC_SELECT,
  password_hash: true,
  failed_login_count: true,
  locked_until: true,
} satisfies Prisma.UserSelect;

const ADMIN_CREDENTIAL_SELECT = {
  ...ADMIN_PUBLIC_SELECT,
  password_hash: true,
  failed_login_count: true,
  locked_until: true,
} satisfies Prisma.AdminUserSelect;

export type UserPublic = Prisma.UserGetPayload<{ select: typeof USER_PUBLIC_SELECT }>;
export type UserCredential = Prisma.UserGetPayload<{ select: typeof USER_CREDENTIAL_SELECT }>;
export type AdminPublic = Prisma.AdminUserGetPayload<{ select: typeof ADMIN_PUBLIC_SELECT }>;
export type AdminCredential = Prisma.AdminUserGetPayload<{
  select: typeof ADMIN_CREDENTIAL_SELECT;
}>;

// ---------------------------------------------------------------------------
// Members (Users)
// ---------------------------------------------------------------------------

export const findUserByEmail = (db: Db, email: string): Promise<UserCredential | null> =>
  db.user.findFirst({ where: { email, deletedAt: null }, select: USER_CREDENTIAL_SELECT });

/**
 * Used only to decide whether a signup may claim a phone number. It deliberately
 * returns a boolean rather than the row: nothing about the other account may reach
 * the caller, because the caller's response is visible to a stranger.
 *
 * `exceptUserId` exists for the re-application path (reject-resubmit spec D-19),
 * where the account submitting the form is the account already holding the
 * number. Without the exclusion an applicant re-applying with their own mobile
 * would be quietly stripped of it — the one case where "taken" means "yours".
 */
export const isPhoneTaken = async (
  db: Db,
  phone: string,
  exceptUserId?: bigint,
): Promise<boolean> =>
  (await db.user.count({
    where: { phone, deletedAt: null, ...(exceptUserId ? { id: { not: exceptUserId } } : {}) },
  })) > 0;

export const findUserById = (db: Db, id: bigint): Promise<UserPublic | null> =>
  db.user.findFirst({ where: { id, deletedAt: null }, select: USER_PUBLIC_SELECT });

export const findUserCredentialById = (db: Db, id: bigint): Promise<UserCredential | null> =>
  db.user.findFirst({ where: { id, deletedAt: null }, select: USER_CREDENTIAL_SELECT });

export interface CreateUserInput {
  email: string;
  full_name: string;
  phone?: string | null;
  password_hash?: string | null;
  status?: UserStatus;
}

export const createUser = (db: Db, input: CreateUserInput): Promise<UserPublic> =>
  db.user.create({
    data: {
      email: input.email,
      password_hash: input.password_hash ?? null,
      full_name: input.full_name,
      phone: input.phone ?? null,
      status: input.status ?? UserStatus.PENDING_VERIFICATION,
    },
    select: USER_PUBLIC_SELECT,
  });

export const updateUser = (db: Db, id: bigint, data: Prisma.UserUpdateInput): Promise<UserPublic> =>
  db.user.update({ where: { id }, data, select: USER_PUBLIC_SELECT });

// ---------------------------------------------------------------------------
// Staff (AdminUsers)
// ---------------------------------------------------------------------------

export const findAdminByEmail = (db: Db, email: string): Promise<AdminCredential | null> =>
  db.adminUser.findFirst({ where: { email, deletedAt: null }, select: ADMIN_CREDENTIAL_SELECT });

export const findAdminById = (db: Db, id: bigint): Promise<AdminPublic | null> =>
  db.adminUser.findFirst({ where: { id, deletedAt: null }, select: ADMIN_PUBLIC_SELECT });

export const findAdminCredentialById = (db: Db, id: bigint): Promise<AdminCredential | null> =>
  db.adminUser.findFirst({ where: { id, deletedAt: null }, select: ADMIN_CREDENTIAL_SELECT });

export const updateAdmin = (
  db: Db,
  id: bigint,
  data: Prisma.AdminUserUpdateInput,
): Promise<AdminPublic> =>
  db.adminUser.update({ where: { id }, data, select: ADMIN_PUBLIC_SELECT });

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------

export interface LiveOtp {
  id: bigint;
  code_hash: string;
  attempt_count: number;
  expires_at: Date;
}

/**
 * Retire every live code for this identifier and purpose.
 *
 * Called immediately before inserting a new one, in the same transaction. The
 * partial unique index `OtpCodes_identifier_purpose_live_key` turns "we always
 * remember to do this" into "the insert fails if we did not".
 */
export const supersedeOtpCodes = (
  db: Db,
  identifier: string,
  purpose: OtpPurpose,
): Promise<unknown> =>
  db.otpCode.updateMany({
    where: { identifier, purpose, consumed_at: null },
    data: { consumed_at: new Date() },
  });

export interface CreateOtpInput {
  identifier: string;
  purpose: OtpPurpose;
  code_hash: string;
  expires_at: Date;
}

export const createOtpCode = (db: Db, input: CreateOtpInput): Promise<{ id: bigint }> =>
  db.otpCode.create({ data: input, select: { id: true } });

/**
 * The single live code for an identifier + purpose.
 *
 * Expiry is checked in the service rather than in this `where`, so an expired
 * code produces "the code has expired" instead of the indistinguishable "no code
 * found" — and so the row can still be retired rather than left behind to block
 * the partial unique index.
 */
export const findLiveOtp = (
  db: Db,
  identifier: string,
  purpose: OtpPurpose,
): Promise<LiveOtp | null> =>
  db.otpCode.findFirst({
    where: { identifier, purpose, consumed_at: null },
    orderBy: { expires_at: 'desc' },
    select: { id: true, code_hash: true, attempt_count: true, expires_at: true },
  });

export const recordOtpAttempt = (db: Db, id: bigint, attemptCount: number): Promise<unknown> =>
  db.otpCode.update({ where: { id }, data: { attempt_count: attemptCount } });

export const consumeOtp = (db: Db, id: bigint): Promise<unknown> =>
  db.otpCode.update({ where: { id }, data: { consumed_at: new Date() } });

// ---------------------------------------------------------------------------
// Refresh sessions
// ---------------------------------------------------------------------------

export interface CreateAuthTokenInput {
  token_hash: string;
  audience: TokenAudience;
  expires_at: Date;
  userId?: bigint | null;
  adminUserId?: bigint | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const createAuthToken = (db: Db, input: CreateAuthTokenInput): Promise<{ id: bigint }> =>
  db.authToken.create({
    data: {
      token_hash: input.token_hash,
      audience: input.audience,
      expires_at: input.expires_at,
      user_id: input.userId ?? null,
      admin_user_id: input.adminUserId ?? null,
      ip: input.ip ?? null,
      user_agent: input.userAgent ? input.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    },
    select: { id: true },
  });

export interface LiveAuthToken {
  id: bigint;
  user_id: bigint | null;
  admin_user_id: bigint | null;
  audience: TokenAudience;
  expires_at: Date;
}

/**
 * Resolve a presented refresh token.
 *
 * Looks up by hash only — expiry and revocation are read back and judged in the
 * service, so "this token was revoked" and "this token never existed" can be
 * told apart in the audit trail even though the client sees the same 401.
 */
export const findAuthTokenByHash = (
  db: Db,
  tokenHash: string,
): Promise<(LiveAuthToken & { revoked_at: Date | null }) | null> =>
  db.authToken.findUnique({
    where: { token_hash: tokenHash },
    select: {
      id: true,
      user_id: true,
      admin_user_id: true,
      audience: true,
      expires_at: true,
      revoked_at: true,
    },
  });

export const revokeAuthToken = (db: Db, id: bigint): Promise<unknown> =>
  db.authToken.update({ where: { id }, data: { revoked_at: new Date() } });

/**
 * logout-all: revoke every live session for one subject (rbac.md §1).
 * Also the correct response to a password change — every other device is now
 * holding a credential the user has just replaced.
 */
export const revokeAllAuthTokens = async (
  db: Db,
  subject: { userId?: bigint | null; adminUserId?: bigint | null },
): Promise<number> => {
  const result = await db.authToken.updateMany({
    where: {
      user_id: subject.userId ?? undefined,
      admin_user_id: subject.adminUserId ?? undefined,
      revoked_at: null,
    },
    data: { revoked_at: new Date() },
  });

  return result.count;
};

// ---------------------------------------------------------------------------
// Password reset links
// ---------------------------------------------------------------------------

export const supersedePasswordResetTokens = (
  db: Db,
  subject: { userId?: bigint | null; adminUserId?: bigint | null },
): Promise<unknown> =>
  db.passwordResetToken.updateMany({
    where: {
      user_id: subject.userId ?? undefined,
      admin_user_id: subject.adminUserId ?? undefined,
      used_at: null,
    },
    data: { used_at: new Date() },
  });

export interface CreatePasswordResetInput {
  token_hash: string;
  expires_at: Date;
  userId?: bigint | null;
  adminUserId?: bigint | null;
}

export const createPasswordResetToken = (
  db: Db,
  input: CreatePasswordResetInput,
): Promise<{ id: bigint }> =>
  db.passwordResetToken.create({
    data: {
      token_hash: input.token_hash,
      expires_at: input.expires_at,
      user_id: input.userId ?? null,
      admin_user_id: input.adminUserId ?? null,
    },
    select: { id: true },
  });

export const findPasswordResetByHash = (
  db: Db,
  tokenHash: string,
): Promise<{
  id: bigint;
  user_id: bigint | null;
  admin_user_id: bigint | null;
  expires_at: Date;
  used_at: Date | null;
} | null> =>
  db.passwordResetToken.findUnique({
    where: { token_hash: tokenHash },
    select: { id: true, user_id: true, admin_user_id: true, expires_at: true, used_at: true },
  });

export const consumePasswordResetToken = (db: Db, id: bigint): Promise<unknown> =>
  db.passwordResetToken.update({ where: { id }, data: { used_at: new Date() } });
