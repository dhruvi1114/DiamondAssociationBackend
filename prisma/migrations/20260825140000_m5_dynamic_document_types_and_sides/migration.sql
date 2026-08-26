-- Reverses 20260824130000_m5_application_document_fixed_kyc_type.
--
-- That migration replaced the DocumentTypes foreign key with an enum because a
-- soft-deleted type broke registration. The foreign key was never the fault: the
-- master's delete had no in-use guard (masters.service.ts). The guard now exists,
-- so the association can configure its own checklist again — which is the point
-- of this change — without the outage that forced the enum.

-- CreateEnum
CREATE TYPE "DocumentSides" AS ENUM ('SINGLE', 'FRONT_AND_BACK');
CREATE TYPE "DocumentSide" AS ENUM ('SINGLE', 'FRONT', 'BACK', 'COMBINED');

-- AlterTable: the master gains its sides setting. Every existing row is SINGLE,
-- which is exactly how it behaved before this migration.
ALTER TABLE "DocumentTypes" ADD COLUMN "sides" "DocumentSides" NOT NULL DEFAULT 'SINGLE';
COMMENT ON COLUMN "DocumentTypes"."sides" IS 'Whether this document is collected as one file or as a front and a back. Existing rows default to SINGLE, which is how every type behaved before M5.';

-- AlterTable: every uploaded file records which face it is.
ALTER TABLE "ApplicationDocuments" ADD COLUMN "side" "DocumentSide" NOT NULL DEFAULT 'SINGLE';
COMMENT ON COLUMN "ApplicationDocuments"."side" IS 'Which face of the document this file is. SINGLE for a one-file type.';

ALTER TABLE "MemberDocuments" ADD COLUMN "side" "DocumentSide" NOT NULL DEFAULT 'SINGLE';
COMMENT ON COLUMN "MemberDocuments"."side" IS 'Which face of the document this file is. SINGLE for a one-file type.';

-- The three registration types become rows. Idempotent: rows an admin created by
-- hand keep their ids, their guidance and their edits.
--
-- applies_to = APPLICATION, not BOTH. Registration behaviour is reproduced
-- exactly and no existing member's profile silently grows three new
-- requirements. An admin can widen any of them from screen A-12 afterwards.
INSERT INTO "DocumentTypes"
  ("code", "name", "description", "applies_to", "is_required", "sides",
   "max_size_mb", "allowed_mime", "display_order", "is_active", "createdAt", "updatedAt")
VALUES
  ('GST_CERTIFICATE', 'GST Certificate', 'A clear scan or PDF of the GST registration certificate.',
   'APPLICATION', true, 'SINGLE', 10, ARRAY['application/pdf','image/jpeg','image/png'], 1, true, NOW(), NOW()),
  ('PAN_DOCUMENT', 'PAN Document', 'The company PAN card, or the proprietor''s PAN for a proprietorship.',
   'APPLICATION', true, 'SINGLE', 10, ARRAY['application/pdf','image/jpeg','image/png'], 2, true, NOW(), NOW()),
  ('TRADE_LICENCE', 'Trade Licence', 'The current trade licence issued by your local authority.',
   'APPLICATION', true, 'SINGLE', 10, ARRAY['application/pdf','image/jpeg','image/png'], 3, true, NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;

-- A type that was soft-deleted but is named by the enum must come back, or the
-- backfill below cannot resolve its files. This is the 2026-08-24 failure, undone.
UPDATE "DocumentTypes"
   SET "deletedAt" = NULL, "is_active" = true
 WHERE "code" IN ('GST_CERTIFICATE', 'PAN_DOCUMENT', 'TRADE_LICENCE')
   AND "deletedAt" IS NOT NULL;

-- AlterTable: nullable first, backfill, then tighten.
ALTER TABLE "ApplicationDocuments" ADD COLUMN "document_type_id" BIGINT;

UPDATE "ApplicationDocuments" ad
   SET "document_type_id" = dt."id"
  FROM "DocumentTypes" dt
 WHERE dt."code" = ad."document_type"::text;

-- Fail loudly. A half-migrated evidence table is worse than a failed deploy: the
-- applicant would appear not to have supplied a document they did supply.
DO $$
DECLARE orphaned INT;
BEGIN
  SELECT COUNT(*) INTO orphaned FROM "ApplicationDocuments" WHERE "document_type_id" IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % ApplicationDocuments rows have no matching DocumentTypes.code', orphaned;
  END IF;
END $$;

ALTER TABLE "ApplicationDocuments" ALTER COLUMN "document_type_id" SET NOT NULL;
COMMENT ON COLUMN "ApplicationDocuments"."document_type_id" IS 'FK to DocumentTypes.id - which checklist requirement this file satisfies. ON DELETE RESTRICT, backed by an application-level in-use guard on the master.';

ALTER TABLE "ApplicationDocuments"
  ADD CONSTRAINT "ApplicationDocuments_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "DocumentTypes"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "ApplicationDocuments_application_id_document_type_idx";
CREATE INDEX "ApplicationDocuments_application_id_document_type_id_idx"
  ON "ApplicationDocuments"("application_id", "document_type_id");

ALTER TABLE "ApplicationDocuments" DROP COLUMN "document_type";
DROP TYPE "RegistrationDocumentType";
