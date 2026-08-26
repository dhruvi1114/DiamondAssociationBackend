import crypto from 'node:crypto';
import { environment } from '@config/config';
import type { Db } from '@db/prisma';
import { hashOpaqueToken } from '@modules/auth/auth.tokens';

/**
 * The applicant's way back into a rejected application, without an account.
 *
 * Registration deliberately creates no password before final approval (spec
 * D-10), so an application sent back for correction cannot be reached by logging
 * in — there is nothing to log in to. The emailed link IS the credential, which
 * makes the three properties below load-bearing rather than decorative:
 *
 *  - **Opaque and random, not a JWT.** A signed token is valid until it expires
 *    no matter what the database thinks. This one is valid only while a row says
 *    so, which is what lets a link die the moment the application is approved or
 *    finally closed (spec §6 item 7).
 *  - **Hashed at rest.** `ApplicationAccessTokens` read access alone hands an
 *    attacker nothing usable — and the same HMAC as `auth.tokens.ts` is used, so
 *    verifying a stolen hash offline also needs the application secret.
 *  - **One application, and nothing else.** The row carries a single
 *    `application_id`. There is no id in the URL for a caller to change, so the
 *    horizontal-access question ("can this link read someone else's KYC?")
 *    cannot arise: the token does not name a resource, it *is* the resource.
 *
 * No fixed expiry (spec OQ-2). `expires_at` stays NULL and the link lives until
 * the application reaches `APPROVED` or `REJECTED`; a correction round that
 * takes three weeks because the applicant's accountant was on leave should not
 * end in a dead link and a support call. The column exists so a future policy
 * change is a value, not a migration.
 */

/** 32 bytes = 256 bits, the same budget `auth.tokens.ts` gives a reset link. */
const TOKEN_BYTES = 32;

/**
 * What a token may look like before we are willing to hash it.
 *
 * base64url of 32 bytes is 43 characters; the range is deliberately loose so a
 * future change of `TOKEN_BYTES` does not silently reject every live link. The
 * point is not precision — it is refusing to run an HMAC over a megabyte of
 * attacker-supplied path segment.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

/** URL-safe random string. base64url so it survives an email link untouched. */
export const generateApplicationAccessToken = (): string =>
  crypto.randomBytes(TOKEN_BYTES).toString('base64url');

/** Keyed digest, 64 hex characters — exactly what `token_hash CHAR(64)` holds. */
export const hashApplicationAccessToken = (token: string): string => hashOpaqueToken(token);

/** The page the applicant lands on. Kept here so the email and the API agree. */
export const resubmitLinkFor = (token: string): string =>
  `${environment.publicBaseUrl}/resubmit/${token}`;

/**
 * Issue a link for this application, retiring whatever came before it.
 *
 * Revoke-then-create rather than create-alongside: the reject transaction runs
 * this on every rejection, and two live links to the same application would mean
 * an old email — forwarded, archived, sitting in a shared inbox — still opens a
 * form the association believes it has superseded. Exactly one token is live at
 * any moment, and the newest email is always the one that works.
 *
 * Takes the caller's `db` so it can join the reject transaction: a link that was
 * emailed for a rejection that rolled back is a link to a decision nobody made.
 */
export const issueApplicationAccessToken = async (
  db: Db,
  applicationId: bigint,
): Promise<{ token: string; url: string }> => {
  await revokeApplicationAccessTokens(db, applicationId);

  const token = generateApplicationAccessToken();

  await db.applicationAccessToken.create({
    data: {
      application_id: applicationId,
      token_hash: hashApplicationAccessToken(token),
      // NULL — no fixed expiry (spec OQ-2). Revocation, not time, closes it.
      expires_at: null,
    },
  });

  return { token, url: resubmitLinkFor(token) };
};

/**
 * Kill every live link to this application.
 *
 * Called on approval and on final rejection, where the link must stop working
 * the moment the decision commits, and again from `issueApplicationAccessToken`
 * so a reissue supersedes rather than accumulates. Returns the number of rows
 * closed so a caller that cares (the backfill script) can report it.
 */
export const revokeApplicationAccessTokens = async (
  db: Db,
  applicationId: bigint,
): Promise<number> => {
  const result = await db.applicationAccessToken.updateMany({
    where: { application_id: applicationId, revoked_at: null },
    data: { revoked_at: new Date() },
  });

  return result.count;
};

export interface ResolvedAccessToken {
  tokenId: bigint;
  applicationId: bigint;
}

/**
 * Presented secret → the one application it opens, or NULL.
 *
 * NULL covers every failure — wrong shape, unknown token, revoked, expired —
 * deliberately. The caller turns all of them into the same 404 with the same
 * words, because "this link was revoked" and "this link never existed" are
 * different facts and telling them apart is a probe an unauthenticated caller
 * should not be handed (security.md §2, horizontal access).
 *
 * The lookup is BY the hash, on a unique index, so the comparison Postgres does
 * is not the one an attacker can time. `timingSafeEqual` on the way out is belt
 * and braces for the day this becomes a scan rather than an index probe — it
 * costs one buffer compare and removes the need to think about it again.
 */
export const resolveApplicationAccessToken = async (
  db: Db,
  presented: string,
): Promise<ResolvedAccessToken | null> => {
  if (!TOKEN_SHAPE.test(presented)) {
    return null;
  }

  const expected = hashApplicationAccessToken(presented);

  const row = await db.applicationAccessToken.findUnique({
    where: { token_hash: expected },
    select: {
      id: true,
      application_id: true,
      expires_at: true,
      revoked_at: true,
      token_hash: true,
    },
  });

  if (!row) {
    return null;
  }

  const matches = crypto.timingSafeEqual(
    Buffer.from(row.token_hash, 'utf8'),
    Buffer.from(expected, 'utf8'),
  );

  if (!matches || row.revoked_at !== null) {
    return null;
  }

  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) {
    return null;
  }

  return { tokenId: row.id, applicationId: row.application_id };
};

/** Is there a working link for this application right now? Used by the backfill. */
export const hasLiveApplicationAccessToken = async (
  db: Db,
  applicationId: bigint,
): Promise<boolean> => {
  const live = await db.applicationAccessToken.findFirst({
    where: {
      application_id: applicationId,
      revoked_at: null,
      OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
    },
    select: { id: true },
  });

  return live !== null;
};
