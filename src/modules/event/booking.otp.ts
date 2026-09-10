import bcrypt from 'bcryptjs';
import { NotificationChannel, OtpPurpose } from '@prisma/client';
import { generateOtpCode } from '@modules/auth/auth.tokens';
import { BCRYPT_COST, OTP } from '@constant/auth.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
import { queueNotification } from '@notifications/outbox';
import { AppError } from '@utils/appError';

/**
 * Emailed codes for the two login-free event journeys: proving the company email
 * on a guest booking, and proving it again at `/my-bookings`.
 *
 * Deliberately a copy of the shape `auth.service.ts` uses for signup codes rather
 * than a shared abstraction over it. The two differ in what they are attached to —
 * a signup code hangs off a `Users` row that exists, these hang off an address that
 * may belong to nobody — and folding them together would put a member-account
 * concern inside a path that must never touch one.
 *
 * The plaintext code is generated, mailed and discarded. Only its bcrypt hash is
 * stored, for the same reason a password is: a six-digit code in a leaked table is
 * worth as much as the account it opens.
 */

export const BOOKING_OTP_TEMPLATE = 'event.booking_otp';
export const LOOKUP_OTP_TEMPLATE = 'event.booking_lookup_otp';

const TEMPLATE_FOR: Record<string, string> = {
  [OtpPurpose.GUEST_BOOKING_VERIFY]: BOOKING_OTP_TEMPLATE,
  [OtpPurpose.BOOKING_LOOKUP]: LOOKUP_OTP_TEMPLATE,
};

const invalidCode = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.VALIDATION_ERROR, messageKey: 'auth.otpInvalid' });

// The code is generated with `generateOtpCode` from `auth.tokens.ts` (CSPRNG via
// `crypto.randomInt`) deliberately — do not reinstate a local `Math.random` one.

/**
 * Issue a code and queue its email in the caller's transaction.
 *
 * Always inside a transaction, for the reason `issueSignupOtp` gives: a code with
 * no email leaves someone waiting for a message that never comes, and an email
 * with no code sends a number that will never verify.
 */
export const issueBookingOtp = async (
  db: Db,
  email: string,
  purpose: OtpPurpose,
): Promise<void> => {
  const code = generateOtpCode(OTP.LENGTH);

  // Retire whatever is live first. The live-code index allows one per
  // (identifier, purpose), so a resend must supersede rather than collide.
  await db.otpCode.updateMany({
    where: { identifier: email, purpose, consumed_at: null },
    data: { consumed_at: new Date() },
  });

  await db.otpCode.create({
    data: {
      identifier: email,
      purpose,
      code_hash: await bcrypt.hash(code, BCRYPT_COST),
      expires_at: new Date(Date.now() + OTP.EXPIRY_MINUTES * 60_000),
    },
  });

  await queueNotification(db, {
    templateCode: TEMPLATE_FOR[purpose]!,
    channel: NotificationChannel.EMAIL,
    toAddress: email,
    payload: { otp: code, expiry_minutes: String(OTP.EXPIRY_MINUTES) },
  });
};

/**
 * Verify and consume a code, or throw.
 *
 * Every failure raises the same `auth.otpInvalid` except the attempt ceiling, which
 * says so plainly — the person needs to know a new code is required, and that fact
 * reveals nothing about whether the address exists.
 *
 * FAILURE bookkeeping — the attempt-count increment, and the two `consumed_at`
 * retirements (expiry, ceiling) — is written through the `prisma` singleton, not
 * the passed `db`, and deliberately so. `db` is very often the caller's own
 * transaction: `verifyGuestEmail` calls this INSIDE the booking transaction, and
 * that transaction throws on the very failure this function raises. Writing the
 * penalty through `db` would roll the penalty back with everything else Prisma
 * undoes on that throw, so a wrong guess would cost nothing and `OTP.MAX_ATTEMPTS`
 * would never trigger — the ceiling would be inert. Committing it through the
 * singleton instead makes it stick regardless of what the caller's transaction
 * does next: there is no booking to protect on a failure path, only a guess to
 * charge for.
 *
 * SUCCESS consumption stays on the passed `db`, unchanged, for the opposite
 * reason: it has to roll back WITH the booking. A booking that fails for some
 * later, unrelated reason must leave the code live, or the applicant is told to
 * request a new one for a booking that never happened.
 */
export const consumeBookingOtp = async (
  db: Db,
  email: string,
  purpose: OtpPurpose,
  code: string,
): Promise<void> => {
  const row = await db.otpCode.findFirst({
    where: { identifier: email, purpose, consumed_at: null },
    orderBy: { id: 'desc' },
  });

  if (!row) throw invalidCode();

  if (row.expires_at.getTime() <= Date.now()) {
    // Retire it, or the live-code index blocks the next resend. Through the
    // singleton — see the note above.
    await prisma.otpCode.update({ where: { id: row.id }, data: { consumed_at: new Date() } });
    throw invalidCode();
  }

  if (row.attempt_count >= OTP.MAX_ATTEMPTS) {
    await prisma.otpCode.update({ where: { id: row.id }, data: { consumed_at: new Date() } });
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'auth.otpMaxAttempts',
    });
  }

  if (!(await bcrypt.compare(code, row.code_hash))) {
    const attempts = row.attempt_count + 1;

    if (attempts >= OTP.MAX_ATTEMPTS) {
      await prisma.otpCode.update({ where: { id: row.id }, data: { consumed_at: new Date() } });
      throw new AppError({
        errorType: ERROR_TYPES.VALIDATION_ERROR,
        messageKey: 'auth.otpMaxAttempts',
      });
    }

    await prisma.otpCode.update({ where: { id: row.id }, data: { attempt_count: attempts } });
    throw invalidCode();
  }

  // Success — through the caller's `db`. See the doc comment above.
  await db.otpCode.update({ where: { id: row.id }, data: { consumed_at: new Date() } });
};
