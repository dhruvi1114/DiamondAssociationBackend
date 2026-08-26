import crypto from 'node:crypto';
import { environment } from '@config/config';
import { hashOpaqueToken } from '@modules/auth/auth.tokens';
import type { Db } from '@db/prisma';

/**
 * Login-free access to one booking.
 *
 * A guest has no account, so they need a way back to their own booking to pay
 * for it. The registration code cannot serve as that key: it is sequential, so
 * anyone could count up from their own and open somebody else's booking.
 *
 * Modelled on `application.tokens.ts`, which solves the identical problem for an
 * applicant correcting a form without an account. Same shape, same guarantees:
 * random secret, stored only as a hash, exactly one live at a time.
 */

/** 32 bytes of entropy. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

/** How long a booking link works. Comfortably longer than any payment hold. */
const TOKEN_TTL_DAYS = 30;

/**
 * Cheap shape check before hashing.
 *
 * The point is not precision — it is refusing to run a digest over a megabyte of
 * attacker-supplied path segment.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

/** URL-safe random string. base64url so it survives an email link untouched. */
export const generateEventAccessToken = (): string =>
  crypto.randomBytes(TOKEN_BYTES).toString('base64url');

/** The page a guest lands on. Kept here so the email and the API agree. */
export const bookingLinkFor = (token: string): string =>
  `${environment.publicBaseUrl}/events/booking/${token}`;

/**
 * Issue a link for this booking, retiring whatever came before it.
 *
 * Revoke-then-create rather than create-alongside: two live links to one booking
 * would mean an old email — forwarded, archived, sitting in a shared inbox —
 * still opens a booking the association believes it has superseded.
 *
 * Takes the caller's `db` so it joins the booking transaction. A link emailed
 * for a booking that then rolled back is a link to nothing.
 */
export const issueEventAccessToken = async (
  db: Db,
  registrationId: bigint,
  now = new Date(),
): Promise<string> => {
  await db.eventAccessToken.updateMany({
    where: { registration_id: registrationId, revoked_at: null },
    data: { revoked_at: now },
  });

  const token = generateEventAccessToken();

  await db.eventAccessToken.create({
    data: {
      registration_id: registrationId,
      token_hash: hashOpaqueToken(token),
      expires_at: new Date(now.getTime() + TOKEN_TTL_DAYS * 86_400_000),
    },
  });

  return token;
};

/**
 * The booking a link opens, or null.
 *
 * Null for every failure — unknown, expired, revoked, malformed. The caller
 * answers 404 in each case: distinguishing them would tell an attacker which
 * guesses were close.
 */
export const resolveEventAccessToken = async (
  db: Db,
  token: string,
  now = new Date(),
): Promise<bigint | null> => {
  if (!TOKEN_SHAPE.test(token)) return null;

  const row = await db.eventAccessToken.findFirst({
    where: { token_hash: hashOpaqueToken(token) },
    select: { registration_id: true, expires_at: true, revoked_at: true },
  });

  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at <= now) return null;

  return row.registration_id;
};

/** Retire every live link to a booking — once it is settled, the link is spent. */
export const revokeEventAccessTokens = (db: Db, registrationId: bigint, now = new Date()) =>
  db.eventAccessToken.updateMany({
    where: { registration_id: registrationId, revoked_at: null },
    data: { revoked_at: now },
  });
