-- =============================================================================
-- M1 — Authentication, RBAC & App Shells
--
-- Adds the three credential tables the auth module needs (database-design.md §A):
--   AuthTokens           refresh sessions for both audiences, stored hashed
--   OtpCodes             signup verification codes, stored hashed
--   PasswordResetTokens  emailed reset links, stored hashed
--
-- Nothing here is destructive: three new tables, two new enums, no ALTER on an
-- existing table.
--
-- Hand-written additions to the Prisma-generated SQL, in order:
--   1. XOR check constraints  exactly one subject per credential row (§A)
--   2. partial unique indexes at most one live credential per subject
--   3. COMMENT ON block       ADR-013, generated from the schema /// docs
-- =============================================================================

-- CreateEnum
CREATE TYPE "TokenAudience" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('SIGNUP_VERIFY', 'PASSWORD_RESET', 'LOGIN_2FA');

-- CreateTable
CREATE TABLE "AuthTokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "admin_user_id" BIGINT,
    "token_hash" TEXT NOT NULL,
    "audience" "TokenAudience" NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "ip" INET,
    "user_agent" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AuthTokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCodes" (
    "id" BIGSERIAL NOT NULL,
    "identifier" VARCHAR(150) NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OtpCodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetTokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "admin_user_id" BIGINT,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PasswordResetTokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthTokens_token_hash_key" ON "AuthTokens"("token_hash");

-- CreateIndex
CREATE INDEX "AuthTokens_user_id_revoked_at_idx" ON "AuthTokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "AuthTokens_admin_user_id_revoked_at_idx" ON "AuthTokens"("admin_user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "AuthTokens_expires_at_idx" ON "AuthTokens"("expires_at");

-- CreateIndex
CREATE INDEX "OtpCodes_identifier_purpose_expires_at_idx" ON "OtpCodes"("identifier", "purpose", "expires_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetTokens_token_hash_key" ON "PasswordResetTokens"("token_hash");

-- CreateIndex
CREATE INDEX "PasswordResetTokens_user_id_idx" ON "PasswordResetTokens"("user_id");

-- CreateIndex
CREATE INDEX "PasswordResetTokens_admin_user_id_idx" ON "PasswordResetTokens"("admin_user_id");

-- CreateIndex
CREATE INDEX "PasswordResetTokens_expires_at_idx" ON "PasswordResetTokens"("expires_at");

-- AddForeignKey
ALTER TABLE "AuthTokens" ADD CONSTRAINT "AuthTokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthTokens" ADD CONSTRAINT "AuthTokens_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "AdminUsers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetTokens" ADD CONSTRAINT "PasswordResetTokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetTokens" ADD CONSTRAINT "PasswordResetTokens_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "AdminUsers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 1. XOR check constraints (database-design.md §A)
--
--    A credential row belongs to exactly one subject. Two nullable FKs without a
--    constraint permit both set (a member session that is also an admin session)
--    and neither set (an orphan credential nobody can revoke). Prisma cannot
--    express a CHECK, so these are written by hand.
--
--    `<>` on two booleans is XOR in Postgres, which is exactly the rule stated
--    in §A: (user_id IS NOT NULL) <> (admin_user_id IS NOT NULL).
-- -----------------------------------------------------------------------------
ALTER TABLE "AuthTokens"
    ADD CONSTRAINT "AuthTokens_subject_xor_check"
    CHECK (("user_id" IS NOT NULL) <> ("admin_user_id" IS NOT NULL));

ALTER TABLE "PasswordResetTokens"
    ADD CONSTRAINT "PasswordResetTokens_subject_xor_check"
    CHECK (("user_id" IS NOT NULL) <> ("admin_user_id" IS NOT NULL));

-- -----------------------------------------------------------------------------
-- 2. Partial unique indexes (database-design.md §H.1, database-indexes.md)
--
--    "At most one live credential per subject" is an invariant the application
--    can only promise; expressed here, it is a fact. Issuing a new code or a new
--    reset link retires the previous one in the same transaction, and the index
--    fails the write if it did not. Without this, a resend leaves both codes
--    valid and the attempt counter on the retired row protects nothing.
--
--    Deliberately NOT applied to AuthTokens: several concurrent live sessions per
--    person (laptop + phone) are normal and revocable individually.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "OtpCodes_identifier_purpose_live_key"
    ON "OtpCodes" ("identifier", "purpose")
    WHERE "consumed_at" IS NULL;

CREATE UNIQUE INDEX "PasswordResetTokens_user_live_key"
    ON "PasswordResetTokens" ("user_id")
    WHERE "user_id" IS NOT NULL AND "used_at" IS NULL;

CREATE UNIQUE INDEX "PasswordResetTokens_admin_user_live_key"
    ON "PasswordResetTokens" ("admin_user_id")
    WHERE "admin_user_id" IS NOT NULL AND "used_at" IS NULL;

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts AuthTokens OtpCodes PasswordResetTokens
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "AuthTokens" IS 'One refresh session, for either audience. The access token is a short-lived JWT that is never stored; this row is what makes a session revocable, because a JWT cannot be recalled once issued. The opaque token itself is never stored — only its HMAC — so a database leak yields no usable session. Rotated on every use: refreshing revokes this row and inserts its successor (rbac.md §1).';
COMMENT ON COLUMN "AuthTokens"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "AuthTokens"."user_id" IS 'FK to Users.id — the member whose session this is. ON DELETE CASCADE: a deleted account''s sessions must not outlive it. NULL when the session belongs to staff; the XOR check constraint guarantees exactly one of user_id / admin_user_id is set.';
COMMENT ON COLUMN "AuthTokens"."admin_user_id" IS 'FK to AdminUsers.id — the staff member whose session this is. ON DELETE CASCADE. NULL for member sessions.';
COMMENT ON COLUMN "AuthTokens"."token_hash" IS 'HMAC-SHA256 of the opaque refresh token, keyed with JWT_REFRESH_SECRET. Unique, because the lookup on refresh is by hash. The plaintext token exists only in the client''s storage and in the response that issued it; it is never logged and never re-derivable from here.';
COMMENT ON COLUMN "AuthTokens"."audience" IS 'MEMBER or ADMIN. Checked against the route''s audience on refresh, so a stolen member refresh token cannot mint an admin access token.';
COMMENT ON COLUMN "AuthTokens"."expires_at" IS 'When this refresh token stops working (UTC): 7 days for members, 1 day for staff (rbac.md §1). Indexed so the prune job can delete expired rows cheaply.';
COMMENT ON COLUMN "AuthTokens"."revoked_at" IS 'When the session was ended (UTC) — by logout, by logout-all, or by being rotated out on a successful refresh. NULL means live. Rows are revoked rather than deleted so a session history exists for an access review.';
COMMENT ON COLUMN "AuthTokens"."ip" IS 'Client address the session was issued to, for the session list and abuse investigation. NULL when the request arrived without a resolvable address.';
COMMENT ON COLUMN "AuthTokens"."user_agent" IS 'User-agent string at issue time, truncated to 512 characters. Shown as "Chrome on macOS" in a session list; never used as an authentication factor.';
COMMENT ON COLUMN "AuthTokens"."createdAt" IS 'Row creation timestamp (UTC) — when the session started.';
COMMENT ON COLUMN "AuthTokens"."updatedAt" IS 'Last modification timestamp (UTC) — bumped when the row is revoked or rotated out.';

COMMENT ON TABLE "OtpCodes" IS 'One issued one-time code. Keyed by the identifier it was sent to rather than by a user id, because a code is issued before the account is proven and, for a resend, before any session exists. At most one live (unconsumed) code exists per identifier and purpose — a partial unique index enforces it, so issuing a new code provably retires the previous one instead of leaving several valid at once.';
COMMENT ON COLUMN "OtpCodes"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "OtpCodes"."identifier" IS 'Where the code was sent: an email address, or a phone number for an SMS/WhatsApp code. Lower-cased before storage so a resend to "A@b.com" finds the code sent to "a@b.com".';
COMMENT ON COLUMN "OtpCodes"."purpose" IS 'What the code authorises: SIGNUP_VERIFY, PASSWORD_RESET or LOGIN_2FA. Part of the lookup key, so a signup code can never be replayed against a password reset.';
COMMENT ON COLUMN "OtpCodes"."code_hash" IS 'bcrypt hash (cost 12) of the numeric code. Hashed rather than stored, because a six-digit code in a leaked table is worth as much as a password. Never logged, never returned.';
COMMENT ON COLUMN "OtpCodes"."expires_at" IS 'When the code stops being accepted (UTC). Ten minutes from issue; short enough that a forwarded email is not a standing credential.';
COMMENT ON COLUMN "OtpCodes"."consumed_at" IS 'When the code was used, or retired by a newer code being issued (UTC). NULL means live. Single-use: a verified code is consumed in the same transaction that acts on it.';
COMMENT ON COLUMN "OtpCodes"."attempt_count" IS 'Wrong guesses so far. At 5 the code is retired rather than left to be brute-forced, and the caller is told to request a new one (auth.otpMaxAttempts).';
COMMENT ON COLUMN "OtpCodes"."createdAt" IS 'Row creation timestamp (UTC) — when the code was issued.';
COMMENT ON COLUMN "OtpCodes"."updatedAt" IS 'Last modification timestamp (UTC) — bumped on each failed attempt and on consumption.';

COMMENT ON TABLE "PasswordResetTokens" IS 'One emailed password-reset link, for either audience. Same XOR rule as AuthTokens. At most one live token exists per subject (partial unique index): requesting a new link retires the previous one, so a reset email that leaks later cannot be used after a newer one was sent.';
COMMENT ON COLUMN "PasswordResetTokens"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "PasswordResetTokens"."user_id" IS 'FK to Users.id — the member resetting their password. ON DELETE CASCADE. NULL for staff; the XOR check constraint guarantees exactly one of the two is set.';
COMMENT ON COLUMN "PasswordResetTokens"."admin_user_id" IS 'FK to AdminUsers.id — the staff member resetting their password. ON DELETE CASCADE. NULL for members.';
COMMENT ON COLUMN "PasswordResetTokens"."token_hash" IS 'HMAC-SHA256 of the opaque token that appears in the emailed URL, keyed with JWT_REFRESH_SECRET. Unique, because the lookup on reset is by hash. The plaintext exists only in the email; it is never stored and never logged.';
COMMENT ON COLUMN "PasswordResetTokens"."expires_at" IS 'When the link stops working (UTC). One hour from issue.';
COMMENT ON COLUMN "PasswordResetTokens"."used_at" IS 'When the link was used, or retired by a newer request (UTC). NULL means live. Single-use: consumption happens in the same transaction as the password change.';
COMMENT ON COLUMN "PasswordResetTokens"."createdAt" IS 'Row creation timestamp (UTC) — when the link was requested.';
COMMENT ON COLUMN "PasswordResetTokens"."updatedAt" IS 'Last modification timestamp (UTC) — bumped on consumption or retirement.';
