-- M7 — login-free links to a booking.
--
-- A guest has no account, so they need a way back to their own booking to pay
-- for it. The registration code cannot serve: it is sequential, so anyone could
-- count up from their own and open someone else's. This is a random secret,
-- stored only as a hash.
--
-- Additive; nothing existing is touched.

BEGIN;

-- CreateTable
CREATE TABLE "EventAccessTokens" (
    "id" BIGSERIAL NOT NULL,
    "registration_id" BIGINT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventAccessTokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventAccessTokens_token_hash_key" ON "EventAccessTokens"("token_hash");

-- CreateIndex
CREATE INDEX "EventAccessTokens_registration_id_idx" ON "EventAccessTokens"("registration_id");

-- AddForeignKey
ALTER TABLE "EventAccessTokens" ADD CONSTRAINT "EventAccessTokens_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "EventRegistrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "EventAccessTokens" IS 'A login-free link to one booking. A guest has no account, so they need some way back to their own booking to pay for it. The registration code cannot serve: it is sequential, so anyone could count up from their own and open somebody else''s booking. This is a random secret, stored only as a hash, emailed once. Modelled on `ApplicationAccessToken`, which solves the identical problem for applicants correcting a form without an account.';
COMMENT ON COLUMN "EventAccessTokens"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "EventAccessTokens"."registration_id" IS 'FK to EventRegistrations.id. ON DELETE CASCADE — a link outliving its booking would be a URL to nothing.';
COMMENT ON COLUMN "EventAccessTokens"."token_hash" IS 'SHA-256 of the emailed secret. Unique, so a lookup is one indexed read of the hash; the plaintext is never stored anywhere.';
COMMENT ON COLUMN "EventAccessTokens"."expires_at" IS 'When the link stops working.';
COMMENT ON COLUMN "EventAccessTokens"."revoked_at" IS 'When it was withdrawn — set once the booking is settled, so a link cannot be replayed after it has served its purpose.';
COMMENT ON COLUMN "EventAccessTokens"."createdAt" IS 'Row creation timestamp (UTC). No updatedAt: a token is issued, then either used or revoked. It is never edited.';

COMMIT;
