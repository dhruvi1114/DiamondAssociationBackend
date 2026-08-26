import type { Request } from 'express';
import bcrypt from 'bcryptjs';
import { NotificationChannel, OtpPurpose, TokenAudience, UserStatus } from '@prisma/client';
import { environment } from '@config/config';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { BCRYPT_COST, LOCKOUT, OTP, PASSWORD_RESET } from '@constant/auth.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma, type Db } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { logger } from '@logger/logger';
import { queueNotification } from '@notifications/outbox';
import * as repo from '@modules/auth/auth.repository';
import {
  accessTokenLifetimeSeconds,
  adminRefreshExpiresAt,
  generateOtpCode,
  generatePasswordResetToken,
  generateRefreshToken,
  hashOpaqueToken,
  memberRefreshExpiresAt,
} from '@modules/auth/auth.tokens';
import type {
  AdminLoginInput,
  AdminLoginResponse,
  AdminMeResponse,
  AdminSessionProfile,
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  LogoutInput,
  MemberLoginResponse,
  MemberMeResponse,
  MemberSessionProfile,
  RefreshInput,
  ResendOtpInput,
  ResetPasswordInput,
  SessionTokens,
  SignupInput,
  VerifyOtpInput,
} from '@modules/auth/auth.types';
import { getAdminAccess, invalidateAdminAccess } from '@modules/rbac/rbac.cache';
import { loadAdminAccess } from '@modules/rbac/rbac.repository';
import { AppError } from '@utils/appError';
import { signAdminAccessToken, signMemberAccessToken } from '@utils/jwt';

/**
 * Authentication for both audiences (rbac.md §1).
 *
 * One module rather than two because the token model, the lockout rule, the
 * hashing policy and `AuthTokens` are shared — see the ownership note in
 * `docs/modules/M1-auth-rbac.md`. The two halves diverge only where the policy
 * genuinely does: password minimum, refresh lifetime, and what the session
 * payload carries.
 *
 * Invariants held throughout:
 *  - a password or an OTP is never returned, never logged, never put in an audit
 *    row (`writeAudit` redacts, but nothing here relies on that backstop);
 *  - every email leaves through the M0 outbox inside the caller's transaction
 *    (ADR-010/ADR-015) — nothing in this file talks to SMTP;
 *  - responses on the unauthenticated endpoints do not reveal whether an address
 *    is registered (security.md §2).
 */

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

const invalidCredentials = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.invalidCredentials' });

const lockedError = (until: Date): AppError =>
  new AppError({
    errorType: ERROR_TYPES.UNAUTHORIZED,
    messageKey: 'auth.accountLocked',
    replacements: {
      minutes: String(Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000))),
    },
  });

interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export const contextFromRequest = (req: Request): RequestContext => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
  requestId: req.requestId ?? null,
});

const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_COST);

/**
 * Constant-ish-time credential comparison.
 *
 * When no account matches we still run a bcrypt comparison against a throwaway
 * hash. Without it, an unknown address answers in ~1 ms and a known one in
 * ~250 ms, which is a perfectly usable account-enumeration oracle regardless of
 * how careful the response body is.
 */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-placeholder', BCRYPT_COST);

const verifyPassword = async (plain: string, hash: string | null): Promise<boolean> => {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }

  return bcrypt.compare(plain, hash);
};

const isLocked = (lockedUntil: Date | null): lockedUntil is Date =>
  lockedUntil !== null && lockedUntil.getTime() > Date.now();

/** Failure bookkeeping shared by both login paths. Returns true if this attempt locked the account. */
const registerFailure = (
  failedCount: number,
): { failed_login_count: number; locked_until: Date | null; locked: boolean } => {
  const next = failedCount + 1;
  const locked = next >= LOCKOUT.MAX_FAILED_ATTEMPTS;

  return {
    // Reset the counter when the lock is applied: the lock itself is now the
    // barrier, and leaving the counter at 5 would re-lock on the first failure
    // after it expires.
    failed_login_count: locked ? 0 : next,
    locked_until: locked ? new Date(Date.now() + LOCKOUT.DURATION_MINUTES * 60_000) : null,
    locked,
  };
};

interface IssueSessionInput {
  audience: TokenAudience;
  userId?: bigint;
  adminUserId?: bigint;
  accessToken: string;
  context: RequestContext;
}

/** Mint the refresh half of a session and persist its hash. */
const issueRefreshToken = async (db: Db, input: IssueSessionInput): Promise<SessionTokens> => {
  const refreshToken = generateRefreshToken();

  await repo.createAuthToken(db, {
    token_hash: hashOpaqueToken(refreshToken),
    audience: input.audience,
    expires_at:
      input.audience === TokenAudience.ADMIN ? adminRefreshExpiresAt() : memberRefreshExpiresAt(),
    userId: input.userId ?? null,
    adminUserId: input.adminUserId ?? null,
    ip: input.context.ip,
    userAgent: input.context.userAgent,
  });

  return {
    access_token: input.accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: accessTokenLifetimeSeconds(),
  };
};

const toMemberProfile = (user: repo.UserPublic): MemberSessionProfile => ({
  id: user.id.toString(),
  email: user.email,
  full_name: user.full_name,
  phone: user.phone,
  status: user.status,
  email_verified_at: user.email_verified_at?.toISOString() ?? null,
  last_login_at: user.last_login_at?.toISOString() ?? null,
});

const toAdminProfile = (admin: repo.AdminPublic): AdminSessionProfile => ({
  id: admin.id.toString(),
  email: admin.email,
  full_name: admin.full_name,
  phone: admin.phone,
  status: admin.status,
  is_super_admin: admin.is_super_admin,
  last_login_at: admin.last_login_at?.toISOString() ?? null,
});

// ---------------------------------------------------------------------------
// OTP issuing — always through the outbox, never inline (ADR-015)
// ---------------------------------------------------------------------------

/**
 * Issue a signup code and queue its email in ONE transaction.
 *
 * The transaction is the whole point: a code written without its email leaves a
 * member waiting for a message that will never arrive, and an email queued
 * without its code sends a number that will never verify. Both statements commit
 * together or neither does.
 *
 * The plaintext code is returned to the caller only so it can go into the
 * notification payload; it is never returned to the client and never logged.
 */
const issueSignupOtp = async (
  db: Db,
  user: { id: bigint; email: string; full_name: string },
): Promise<void> => {
  const code = generateOtpCode(OTP.LENGTH);

  await repo.supersedeOtpCodes(db, user.email, OtpPurpose.SIGNUP_VERIFY);

  await repo.createOtpCode(db, {
    identifier: user.email,
    purpose: OtpPurpose.SIGNUP_VERIFY,
    code_hash: await bcrypt.hash(code, BCRYPT_COST),
    expires_at: new Date(Date.now() + OTP.EXPIRY_MINUTES * 60_000),
  });

  await queueNotification(db, {
    templateCode: 'auth.signup_otp',
    channel: NotificationChannel.EMAIL,
    userId: user.id,
    toAddress: user.email,
    payload: {
      full_name: user.full_name,
      otp: code,
      expiry_minutes: String(OTP.EXPIRY_MINUTES),
      organisation_name: 'Association',
    },
  });
};

// ---------------------------------------------------------------------------
// Member: signup, verification
// ---------------------------------------------------------------------------

/**
 * Create a member login and send its verification code.
 *
 * **Enumeration-safe.** The response is byte-identical whether or not the
 * address is already registered (security.md §2). What differs is what happens
 * server-side:
 *  - unknown address        → create the account, send a code
 *  - registered, unverified → send a fresh code (it is the same person, mid-signup)
 *  - registered, verified   → do nothing at all; sending "someone tried to sign
 *    up as you" would need a template that does not exist, and silently mailing
 *    a code would let a stranger spam a member's inbox
 */
export const signup = async (input: SignupInput, context: RequestContext): Promise<void> => {
  const existing = await repo.findUserByEmail(prisma, input.email);

  if (existing) {
    if (existing.status === UserStatus.PENDING_VERIFICATION) {
      await prisma.$transaction(async (tx) => {
        await issueSignupOtp(tx, {
          id: existing.id,
          email: existing.email,
          full_name: existing.full_name,
        });
      });
    } else {
      logger.info('auth.signupOnExistingAccount', {
        // The address itself is not logged: it is the personal datum this line
        // would otherwise scatter across the log stream on every attempt.
        userId: existing.id.toString(),
        status: existing.status,
      });
    }

    return;
  }

  const passwordHash = await hashPassword(input.password);

  // A phone number is unique across members, but a signup must not become an
  // oracle for it: answering 409 for a taken number and 201 for a free one tells
  // a stranger whether a given number belongs to a member (security.md §2, the
  // same rule that shapes the email path above).
  //
  // So the account is still created — just without the number. The signup
  // succeeds, the response is identical either way, and the collision surfaces in
  // M3's profile screen, where the person is authenticated and a plain "that
  // number is already on another account" message is safe to show.
  const phone = input.phone ?? null;
  const phoneClaimable = phone === null ? false : !(await repo.isPhoneTaken(prisma, phone));

  if (phone !== null && !phoneClaimable) {
    logger.info('auth.signupPhoneAlreadyClaimed', {
      // The number itself is not logged — it is personal data (observability.md §3).
      reason: 'phone_taken_account_created_without_it',
    });
  }

  await prisma.$transaction(async (tx) => {
    const user = await repo.createUser(tx, {
      email: input.email,
      password_hash: passwordHash,
      full_name: input.full_name,
      phone: phoneClaimable ? phone : null,
      status: UserStatus.PENDING_VERIFICATION,
    });

    await issueSignupOtp(tx, { id: user.id, email: user.email, full_name: user.full_name });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.USER_SIGNED_UP,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      after: { email: user.email, full_name: user.full_name, status: user.status },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
  });
};

/**
 * Consume a signup code.
 *
 * Failure modes are deliberately distinguishable to the legitimate user (wrong
 * code vs expired vs too many attempts — C-07 needs all three) but say nothing
 * about whether the address exists: an unknown address gets the same
 * `auth.otpInvalid` as a wrong code.
 */
export const verifyOtp = async (
  input: VerifyOtpInput,
  context: RequestContext,
): Promise<MemberLoginResponse> => {
  const otpInvalid = (): AppError =>
    new AppError({ errorType: ERROR_TYPES.VALIDATION_ERROR, messageKey: 'auth.otpInvalid' });

  const user = await repo.findUserByEmail(prisma, input.email);

  if (!user) {
    throw otpInvalid();
  }

  const otp = await repo.findLiveOtp(prisma, input.email, OtpPurpose.SIGNUP_VERIFY);

  if (!otp) {
    throw otpInvalid();
  }

  if (otp.expires_at.getTime() <= Date.now()) {
    // Retire it so the next resend is not blocked by the live-code unique index.
    await repo.consumeOtp(prisma, otp.id);
    throw otpInvalid();
  }

  if (otp.attempt_count >= OTP.MAX_ATTEMPTS) {
    await repo.consumeOtp(prisma, otp.id);
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.otpMaxAttempts',
    });
  }

  if (!(await bcrypt.compare(input.code, otp.code_hash))) {
    const attempts = otp.attempt_count + 1;

    if (attempts >= OTP.MAX_ATTEMPTS) {
      await repo.consumeOtp(prisma, otp.id);
      throw new AppError({
        errorType: ERROR_TYPES.VALIDATION_ERROR,
        messageKey: 'auth.otpMaxAttempts',
      });
    }

    await repo.recordOtpAttempt(prisma, otp.id, attempts);
    throw otpInvalid();
  }

  const accessToken = signMemberAccessToken({ userId: user.id, status: UserStatus.ACTIVE });

  const result = await prisma.$transaction(async (tx) => {
    await repo.consumeOtp(tx, otp.id);

    const verified = await repo.updateUser(tx, user.id, {
      status: UserStatus.ACTIVE,
      email_verified_at: new Date(),
      last_login_at: new Date(),
      failed_login_count: 0,
      locked_until: null,
    });

    const tokens = await issueRefreshToken(tx, {
      audience: TokenAudience.MEMBER,
      userId: user.id,
      accessToken,
      context,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.USER_EMAIL_VERIFIED,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      before: { status: user.status, email_verified_at: null },
      after: { status: verified.status },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { tokens, verified };
  });

  // Verification signs the member in: they have just proven the address and
  // supplied the password minutes ago, so a second sign-in form here is a step
  // that asks the user to repeat themselves.
  return { ...result.tokens, user: toMemberProfile(result.verified) };
};

/** Re-send a signup code. Silent for unknown or already-verified addresses. */
export const resendOtp = async (input: ResendOtpInput): Promise<void> => {
  const user = await repo.findUserByEmail(prisma, input.email);

  if (!user || user.status !== UserStatus.PENDING_VERIFICATION) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    await issueSignupOtp(tx, { id: user.id, email: user.email, full_name: user.full_name });
  });
};

// ---------------------------------------------------------------------------
// Member: login / session
// ---------------------------------------------------------------------------

export const login = async (
  input: LoginInput,
  context: RequestContext,
): Promise<MemberLoginResponse> => {
  const user = await repo.findUserByEmail(prisma, input.email);

  if (!user) {
    // Still pay the bcrypt cost, still write the audit row: a burst of attempts
    // against addresses that do not exist is exactly the signal worth keeping.
    await verifyPassword(input.password, null);

    await writeAudit(prisma, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      entityName: 'Users',
      entityId: null,
      actorType: ACTOR_TYPES.SYSTEM,
      after: { reason: 'unknown_identifier' },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    throw invalidCredentials();
  }

  if (isLocked(user.locked_until)) {
    await writeAudit(prisma, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_BLOCKED,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      after: { locked_until: user.locked_until.toISOString() },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    throw lockedError(user.locked_until);
  }

  if (!(await verifyPassword(input.password, user.password_hash))) {
    const failure = registerFailure(user.failed_login_count);

    await prisma.$transaction(async (tx) => {
      await repo.updateUser(tx, user.id, {
        failed_login_count: failure.failed_login_count,
        locked_until: failure.locked_until,
      });

      await writeAudit(tx, {
        action: failure.locked
          ? AUDIT_ACTIONS.AUTH_ACCOUNT_LOCKED
          : AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        entityName: 'Users',
        entityId: user.id,
        actorType: ACTOR_TYPES.MEMBER,
        actorId: user.id,
        after: failure.locked
          ? {
              locked_until: failure.locked_until?.toISOString(),
              threshold: LOCKOUT.MAX_FAILED_ATTEMPTS,
            }
          : { failed_login_count: failure.failed_login_count },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
    });

    if (failure.locked && failure.locked_until) {
      throw lockedError(failure.locked_until);
    }

    throw invalidCredentials();
  }

  if (user.status === UserStatus.PENDING_APPROVAL) {
    throw new AppError({
      errorType: ERROR_TYPES.FORBIDDEN,
      messageKey: 'auth.pendingApproval',
    });
  }

  // Correct password, but the address was never proven. Told plainly, because
  // the recovery ("resend the code") is a real next step the UI offers (C-08).
  if (user.status === UserStatus.PENDING_VERIFICATION) {
    if (!user.password_hash) {
      throw new AppError({
        errorType: ERROR_TYPES.FORBIDDEN,
        messageKey: 'auth.setPasswordRequired',
      });
    }

    throw new AppError({
      errorType: ERROR_TYPES.FORBIDDEN,
      messageKey: 'auth.emailNotVerified',
    });
  }

  if (user.status !== UserStatus.ACTIVE) {
    throw new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey: 'auth.accountInactive' });
  }

  const accessToken = signMemberAccessToken({ userId: user.id, status: user.status });

  const result = await prisma.$transaction(async (tx) => {
    const updated = await repo.updateUser(tx, user.id, {
      last_login_at: new Date(),
      failed_login_count: 0,
      locked_until: null,
    });

    const tokens = await issueRefreshToken(tx, {
      audience: TokenAudience.MEMBER,
      userId: user.id,
      accessToken,
      context,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { tokens, updated };
  });

  return { ...result.tokens, user: toMemberProfile(result.updated) };
};

/**
 * Rotate a refresh token (rbac.md §1).
 *
 * Rotation, not reuse: the presented row is revoked and a new one issued in the
 * same transaction. A stolen token therefore works at most once, and the moment
 * the legitimate client refreshes, the thief's copy is dead.
 *
 * `expectedAudience` is checked against the stored row, so a member refresh
 * token posted to `/auth/admin/refresh` fails here for the same reason a member
 * access token fails on an admin route.
 */
export const refreshSession = async (
  input: RefreshInput,
  expectedAudience: TokenAudience,
  context: RequestContext,
): Promise<SessionTokens> => {
  const tokenHash = hashOpaqueToken(input.refresh_token);
  const row = await repo.findAuthTokenByHash(prisma, tokenHash);

  const reject = async (reason: string, entityId?: bigint | null): Promise<never> => {
    await writeAudit(prisma, {
      action: AUDIT_ACTIONS.AUTH_TOKEN_REJECTED,
      entityName: 'AuthTokens',
      entityId: entityId ?? null,
      actorType: ACTOR_TYPES.SYSTEM,
      after: { reason, audience: expectedAudience },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.invalidToken' });
  };

  if (!row) {
    return reject('not_found');
  }

  if (row.audience !== expectedAudience) {
    return reject('wrong_audience', row.id);
  }

  if (row.revoked_at) {
    // Either a logout, or a token that was already rotated — i.e. a replay.
    // Revoking the whole subject here (a common "reuse detection" response) is
    // deliberately NOT done: a client that retries a request after a flaky
    // network would sign itself out, and this MVP has no way to tell the two
    // apart. Recorded so the pattern is at least visible.
    return reject('revoked', row.id);
  }

  if (row.expires_at.getTime() <= Date.now()) {
    return reject('expired', row.id);
  }

  const isAdmin = expectedAudience === TokenAudience.ADMIN;

  let accessToken: string;

  if (isAdmin) {
    if (!row.admin_user_id) {
      return reject('subject_missing', row.id);
    }

    const access = await getAdminAccess(row.admin_user_id);

    if (!access || access.status !== UserStatus.ACTIVE) {
      return reject('subject_inactive', row.id);
    }

    accessToken = signAdminAccessToken({
      adminUserId: access.id,
      roles: access.roles.map((role) => role.code),
      permissions: access.permissions,
      isSuperAdmin: access.is_super_admin,
    });
  } else {
    if (!row.user_id) {
      return reject('subject_missing', row.id);
    }

    const user = await repo.findUserById(prisma, row.user_id);

    if (!user || user.status !== UserStatus.ACTIVE) {
      return reject('subject_inactive', row.id);
    }

    accessToken = signMemberAccessToken({ userId: user.id, status: user.status });
  }

  return prisma.$transaction(async (tx) => {
    await repo.revokeAuthToken(tx, row.id);

    const tokens = await issueRefreshToken(tx, {
      audience: expectedAudience,
      userId: row.user_id ?? undefined,
      adminUserId: row.admin_user_id ?? undefined,
      accessToken,
      context,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED,
      entityName: 'AuthTokens',
      entityId: row.id,
      actorType: isAdmin ? ACTOR_TYPES.ADMIN : ACTOR_TYPES.MEMBER,
      actorId: row.admin_user_id ?? row.user_id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return tokens;
  });
};

/**
 * End a session, or every session for this subject (`all: true`).
 *
 * Idempotent by design: logging out with a token that is already revoked, or
 * with no token at all, succeeds. A sign-out that can fail leaves a user stuck
 * on a screen whose only action does not work.
 */
export const logout = async (
  input: LogoutInput,
  subject: { userId?: bigint; adminUserId?: bigint },
  context: RequestContext,
): Promise<{ revoked: number }> => {
  const isAdmin = subject.adminUserId !== undefined;

  return prisma.$transaction(async (tx) => {
    let revoked = 0;

    if (input.all) {
      revoked = await repo.revokeAllAuthTokens(tx, subject);
    } else if (input.refresh_token) {
      const row = await repo.findAuthTokenByHash(tx, hashOpaqueToken(input.refresh_token));

      // Only the owner may revoke it — otherwise anyone holding a valid access
      // token could sign out any session whose refresh token they had seen.
      const owned =
        row &&
        !row.revoked_at &&
        (isAdmin ? row.admin_user_id === subject.adminUserId : row.user_id === subject.userId);

      if (owned) {
        await repo.revokeAuthToken(tx, row.id);
        revoked = 1;
      }
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.AUTH_LOGGED_OUT,
      entityName: isAdmin ? 'AdminUsers' : 'Users',
      entityId: subject.adminUserId ?? subject.userId ?? null,
      actorType: isAdmin ? ACTOR_TYPES.ADMIN : ACTOR_TYPES.MEMBER,
      actorId: subject.adminUserId ?? subject.userId ?? null,
      after: { scope: input.all ? 'all' : 'session', revoked },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { revoked };
  });
};

// ---------------------------------------------------------------------------
// Member: password recovery
// ---------------------------------------------------------------------------

/**
 * Request a reset link.
 *
 * Always answers the same way (`auth.passwordResetSent`) — the caller cannot
 * tell a registered address from an unregistered one, which is the whole point
 * (security.md §2). Nothing is queued for an unknown address.
 */
export const forgotPassword = async (
  input: ForgotPasswordInput,
  context: RequestContext,
): Promise<void> => {
  const user = await repo.findUserByEmail(prisma, input.email);

  if (!user || user.status === UserStatus.BLOCKED) {
    logger.info('auth.passwordResetForUnknownAccount', { matched: false });
    return;
  }

  const token = generatePasswordResetToken();

  await prisma.$transaction(async (tx) => {
    await repo.supersedePasswordResetTokens(tx, { userId: user.id });

    await repo.createPasswordResetToken(tx, {
      token_hash: hashOpaqueToken(token),
      expires_at: new Date(Date.now() + PASSWORD_RESET.EXPIRY_MINUTES * 60_000),
      userId: user.id,
    });

    await queueNotification(tx, {
      templateCode: 'auth.password_reset',
      channel: NotificationChannel.EMAIL,
      userId: user.id,
      toAddress: user.email,
      payload: {
        full_name: user.full_name,
        // The customer app owns this route (C-09); the base URL is the API's
        // public origin only until a CUSTOMER_BASE_URL exists, which is Agent A's
        // env to add.
        reset_url: `${environment.publicBaseUrl}/reset-password?token=${token}`,
        expiry_minutes: String(PASSWORD_RESET.EXPIRY_MINUTES),
      },
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
  });
};

/**
 * Consume a reset link and set the new password.
 *
 * Every live session is revoked in the same transaction. Whoever forced the
 * reset — the owner who forgot, or an attacker who had the account — the other
 * party's sessions must not survive it.
 */
export const resetPassword = async (
  input: ResetPasswordInput,
  context: RequestContext,
): Promise<void> => {
  const invalidToken = (): AppError =>
    new AppError({ errorType: ERROR_TYPES.VALIDATION_ERROR, messageKey: 'auth.resetTokenInvalid' });

  const row = await repo.findPasswordResetByHash(prisma, hashOpaqueToken(input.token));

  if (!row || row.used_at || row.expires_at.getTime() <= Date.now()) {
    throw invalidToken();
  }

  // Admin resets are not reachable from any M1 endpoint (there is no staff
  // forgot-password screen), but the table serves both audiences, so the guard
  // is written rather than assumed.
  if (!row.user_id) {
    throw invalidToken();
  }

  const user = await repo.findUserById(prisma, row.user_id);

  if (!user) {
    throw invalidToken();
  }

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    await repo.consumePasswordResetToken(tx, row.id);

    await repo.updateUser(tx, user.id, {
      password_hash: passwordHash,
      failed_login_count: 0,
      locked_until: null,
      // A successful reset proves control of the mailbox, so an account still
      // waiting on its signup code is verified by this too.
      status: user.status === UserStatus.PENDING_VERIFICATION ? UserStatus.ACTIVE : user.status,
      email_verified_at: user.email_verified_at ?? new Date(),
    });

    await repo.revokeAllAuthTokens(tx, { userId: user.id });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_COMPLETED,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      after: { sessions_revoked: true },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
  });
};

/**
 * After admin approval, email a one-time link so a registration-only account
 * can set its first password (spec D-12, Option B).
 */
export const issueInitialPasswordLink = async (
  tx: Db,
  user: { id: bigint; email: string; full_name: string },
  context: RequestContext,
): Promise<void> => {
  const token = generatePasswordResetToken();

  await repo.supersedePasswordResetTokens(tx, { userId: user.id });

  await repo.createPasswordResetToken(tx, {
    token_hash: hashOpaqueToken(token),
    expires_at: new Date(Date.now() + PASSWORD_RESET.EXPIRY_MINUTES * 60_000),
    userId: user.id,
  });

  await repo.updateUser(tx, user.id, { status: UserStatus.PENDING_VERIFICATION });

  await queueNotification(tx, {
    templateCode: 'auth.password_reset',
    channel: NotificationChannel.EMAIL,
    userId: user.id,
    toAddress: user.email,
    payload: {
      full_name: user.full_name,
      reset_url: `${environment.publicBaseUrl}/set-password?token=${token}`,
      expiry_minutes: String(PASSWORD_RESET.EXPIRY_MINUTES),
    },
  });

  await writeAudit(tx, {
    action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
    entityName: 'Users',
    entityId: user.id,
    actorType: ACTOR_TYPES.SYSTEM,
    after: { reason: 'initial_password_after_approval' },
    ip: context.ip,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });
};

/** Consume an approval email link and set the member's first password. */
export const setInitialPassword = async (
  input: { token: string; password: string },
  context: RequestContext,
): Promise<void> => {
  const invalidToken = (): AppError =>
    new AppError({ errorType: ERROR_TYPES.VALIDATION_ERROR, messageKey: 'auth.resetTokenInvalid' });

  const row = await repo.findPasswordResetByHash(prisma, hashOpaqueToken(input.token));

  if (!row || row.used_at || row.expires_at.getTime() <= Date.now() || !row.user_id) {
    throw invalidToken();
  }

  const user = await repo.findUserCredentialById(prisma, row.user_id);

  if (!user || user.status !== UserStatus.PENDING_VERIFICATION || user.password_hash) {
    throw invalidToken();
  }

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    await repo.consumePasswordResetToken(tx, row.id);

    await repo.updateUser(tx, user.id, {
      password_hash: passwordHash,
      status: UserStatus.ACTIVE,
      email_verified_at: new Date(),
      failed_login_count: 0,
      locked_until: null,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.USER_EMAIL_VERIFIED,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      before: { status: user.status, email_verified_at: null },
      after: { status: UserStatus.ACTIVE },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
  });
};

/** In-session password change. Revokes every OTHER session, keeps this one alive. */
export const changePassword = async (
  userId: bigint,
  input: ChangePasswordInput,
  context: RequestContext,
): Promise<void> => {
  const user = await repo.findUserCredentialById(prisma, userId);

  if (!user) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.invalidToken' });
  }

  if (!(await verifyPassword(input.current_password, user.password_hash))) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.currentPasswordIncorrect',
      details: { fields: { current_password: 'auth.currentPasswordIncorrect' } },
    });
  }

  const passwordHash = await hashPassword(input.new_password);

  await prisma.$transaction(async (tx) => {
    await repo.updateUser(tx, user.id, { password_hash: passwordHash });
    await repo.revokeAllAuthTokens(tx, { userId: user.id });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED,
      entityName: 'Users',
      entityId: user.id,
      actorType: ACTOR_TYPES.MEMBER,
      actorId: user.id,
      after: { sessions_revoked: true },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
  });
};

// ---------------------------------------------------------------------------
// Member: session profile
// ---------------------------------------------------------------------------

export const me = async (userId: bigint): Promise<MemberMeResponse> => {
  const user = await repo.findUserById(prisma, userId);

  if (!user) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.invalidToken' });
  }

  return {
    user: toMemberProfile(user),
    member: null,
    capabilities: {
      email_verified: user.email_verified_at !== null,
      account_active: user.status === UserStatus.ACTIVE,
      // M3 creates the Members row when an application starts (ADR-016).
      has_member_record: false,
      can_change_password: true,
    },
  };
};

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export const adminLogin = async (
  input: AdminLoginInput,
  context: RequestContext,
): Promise<AdminLoginResponse> => {
  const admin = await repo.findAdminByEmail(prisma, input.email);

  if (!admin) {
    await verifyPassword(input.password, null);

    await writeAudit(prisma, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
      entityName: 'AdminUsers',
      entityId: null,
      actorType: ACTOR_TYPES.SYSTEM,
      after: { reason: 'unknown_identifier' },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    throw invalidCredentials();
  }

  if (isLocked(admin.locked_until)) {
    await writeAudit(prisma, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_BLOCKED,
      entityName: 'AdminUsers',
      entityId: admin.id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: admin.id,
      after: { locked_until: admin.locked_until.toISOString() },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    throw lockedError(admin.locked_until);
  }

  if (!(await verifyPassword(input.password, admin.password_hash))) {
    const failure = registerFailure(admin.failed_login_count);

    await prisma.$transaction(async (tx) => {
      await repo.updateAdmin(tx, admin.id, {
        failed_login_count: failure.failed_login_count,
        locked_until: failure.locked_until,
      });

      await writeAudit(tx, {
        action: failure.locked
          ? AUDIT_ACTIONS.AUTH_ACCOUNT_LOCKED
          : AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        entityName: 'AdminUsers',
        entityId: admin.id,
        actorType: ACTOR_TYPES.ADMIN,
        actorId: admin.id,
        after: failure.locked
          ? {
              locked_until: failure.locked_until?.toISOString(),
              threshold: LOCKOUT.MAX_FAILED_ATTEMPTS,
            }
          : { failed_login_count: failure.failed_login_count },
        ip: context.ip,
        userAgent: context.userAgent,
        requestId: context.requestId,
      });
    });

    if (failure.locked && failure.locked_until) {
      throw lockedError(failure.locked_until);
    }

    throw invalidCredentials();
  }

  if (admin.status !== UserStatus.ACTIVE) {
    throw new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey: 'auth.accountInactive' });
  }

  const access = await loadAdminAccess(prisma, admin.id);

  if (!access) {
    throw new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey: 'auth.accountInactive' });
  }

  // A staff account with no role can sign in and holds nothing. Screen A-01
  // renders that as its own state rather than a failure — refusing the login
  // would leave the person unable to distinguish it from a wrong password, and
  // "your account has no role yet" is an answerable message.
  if (access.roles.length === 0 && !access.is_super_admin) {
    logger.warn('auth.adminWithoutRoles', { adminUserId: admin.id.toString() });
  }

  const accessToken = signAdminAccessToken({
    adminUserId: admin.id,
    roles: access.roles.map((role) => role.code),
    permissions: access.permissions,
    isSuperAdmin: access.is_super_admin,
  });

  const result = await prisma.$transaction(async (tx) => {
    const updated = await repo.updateAdmin(tx, admin.id, {
      last_login_at: new Date(),
      failed_login_count: 0,
      locked_until: null,
    });

    const tokens = await issueRefreshToken(tx, {
      audience: TokenAudience.ADMIN,
      adminUserId: admin.id,
      accessToken,
      context,
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
      entityName: 'AdminUsers',
      entityId: admin.id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: admin.id,
      after: { roles: access.roles.map((role) => role.code) },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });

    return { tokens, updated };
  });

  // The freshly-issued session must see the current roles even if this admin's
  // entry was cached moments ago with an older set.
  invalidateAdminAccess(admin.id);

  return {
    ...result.tokens,
    admin: toAdminProfile(result.updated),
    roles: access.roles,
    permissions: access.permissions,
  };
};

export const adminMe = async (adminUserId: bigint): Promise<AdminMeResponse> => {
  const admin = await repo.findAdminById(prisma, adminUserId);
  const access = await getAdminAccess(adminUserId);

  if (!admin || !access) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.invalidToken' });
  }

  return {
    admin: toAdminProfile(admin),
    roles: access.roles,
    // The live set, not the token's hash. This is what the admin UI gates on,
    // and re-fetching it is how a revoked permission disappears from the nav.
    permissions: access.permissions,
  };
};
