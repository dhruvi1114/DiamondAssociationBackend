-- M5 reject & resubmit: Reject replaces Return.
--
-- Three structural changes and two data ones, all consequences of the same
-- decision (docs/specs/2026-08-25-reject-resubmit-flow.md):
--
--  * ApplicationAccessTokens — the applicant's way back in. Registration creates
--    no password before final approval, so an application sent back for
--    correction is unreachable by login. A hashed token in a link is.
--  * ApplicationDocuments.requires_reupload — which files the applicant still
--    owes. A VERIFIED document survives a rejection (D-12) and must not be asked
--    for again.
--  * ApprovalStages.allow_return — dropped. There is no Return action left for a
--    stage to permit or forbid (D-1).
--  * The application.return permission and its grants — dropped for the same
--    reason. ApprovalActionType.RETURN and ApprovalRequestStatus.RETURNED are
--    deliberately KEPT: historical rows carry them, and Reject now produces them
--    whenever attempts remain.
--  * application.max_resubmissions — 0 (unlimited) becomes 3 (D-4).

-- CreateTable
CREATE TABLE "ApplicationAccessTokens" (
    "id" BIGSERIAL NOT NULL,
    "application_id" BIGINT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApplicationAccessTokens_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ApplicationDocuments" ADD COLUMN "requires_reupload" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ApprovalStages" DROP COLUMN "allow_return";

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationAccessTokens_token_hash_key" ON "ApplicationAccessTokens"("token_hash");
CREATE INDEX "ApplicationAccessTokens_application_id_idx" ON "ApplicationAccessTokens"("application_id");

-- AddForeignKey
ALTER TABLE "ApplicationAccessTokens" ADD CONSTRAINT "ApplicationAccessTokens_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "MembershipApplications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Retire the application.return permission. The grants go first so the row can
-- leave without relying on a cascade, and the seed's reconcile step would drop
-- them on the next run anyway — doing it here means an environment that is not
-- re-seeded does not keep offering a button that no longer has a route.
DELETE FROM "RolePermissions"
 WHERE permission_id IN (SELECT id FROM "Permissions" WHERE code = 'application.return');

DELETE FROM "Permissions" WHERE code = 'application.return';

-- Move the resubmission cap off "unlimited" (spec D-4).
--
-- Scoped to rows still holding the old seeded default: an association that has
-- deliberately typed a number keeps it. A value of 0 is indistinguishable from
-- an untouched seed, so this does overwrite anyone who chose unlimited on
-- purpose — which is the intended reading, because unlimited retries are what
-- the spec removes.
UPDATE "SystemSettings"
   SET value = '3',
       description = 'How many times a rejected application may be corrected and resubmitted before it closes permanently. 0 = unlimited. Set by the super admin; compared against MembershipApplications.resubmission_count when a reviewer rejects.',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE key = 'application.max_resubmissions'
   AND value = '0';

-- Table & column comments (ADR-013)
COMMENT ON TABLE  "ApplicationAccessTokens" IS 'Login-free links that let an applicant reopen and correct a rejected application. Only the SHA-256 of the secret is stored; one live token per application, reissued on every reject and revoked on APPROVED or REJECTED.';

COMMENT ON COLUMN "ApplicationAccessTokens"."id"             IS 'Surrogate key.';
COMMENT ON COLUMN "ApplicationAccessTokens"."application_id" IS 'FK to MembershipApplications.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "ApplicationAccessTokens"."token_hash"     IS 'SHA-256 of the emailed secret. Unique; the plaintext is never stored.';
COMMENT ON COLUMN "ApplicationAccessTokens"."expires_at"     IS 'When the link stops working, or NULL for no fixed expiry (spec OQ-2, resolved 2026-08-25).';
COMMENT ON COLUMN "ApplicationAccessTokens"."revoked_at"     IS 'When the link was withdrawn — on approval, on final rejection, and on reissue.';
COMMENT ON COLUMN "ApplicationAccessTokens"."createdAt"      IS 'Row creation timestamp (UTC). A token is issued, then used or revoked; it is never edited.';

COMMENT ON COLUMN "ApplicationDocuments"."requires_reupload" IS 'Whether the applicant must replace this file before resubmitting. Set by the reject transaction for every document marked rejected, cleared when a replacement is uploaded; a VERIFIED document is never asked for again (spec D-12).';
