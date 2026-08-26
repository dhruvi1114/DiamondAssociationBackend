-- ApplicationDocuments.document_type_id was a foreign key into DocumentTypes.
-- Registration's three KYC uploads are fixed by code (spec D-3) and DocumentTypes
-- rows can be soft-deleted independently — which is exactly what broke GST_CERTIFICATE
-- and left registration unable to attach that upload. Replacing the FK with a
-- Postgres enum removes the class of bug entirely: there is no row to delete.
--
-- MemberDocuments keeps its FK to DocumentTypes untouched — that is a separate,
-- still-configurable checklist for post-approval member profile documents (OQ-9),
-- unrelated to this fixed registration list.

-- CreateEnum
CREATE TYPE "RegistrationDocumentType" AS ENUM ('GST_CERTIFICATE', 'PAN_DOCUMENT', 'TRADE_LICENCE');

-- AlterTable: add nullable first, backfill, then tighten to NOT NULL.
ALTER TABLE "ApplicationDocuments" ADD COLUMN "document_type" "RegistrationDocumentType";

-- Backfill from the old FK's DocumentTypes.code. One dev-only row in the local
-- database pointed at a stray, typo'd type ("GST_CERTIFICATESS") left over from
-- when DocumentTypes admin CRUD still existed; it maps to its obvious intended
-- value. Any other unmapped code fails loudly via the NOT NULL below rather than
-- silently defaulting.
UPDATE "ApplicationDocuments" ad
   SET "document_type" = CASE dt.code
         WHEN 'GST_CERTIFICATE'    THEN 'GST_CERTIFICATE'::"RegistrationDocumentType"
         WHEN 'PAN_DOCUMENT'       THEN 'PAN_DOCUMENT'::"RegistrationDocumentType"
         WHEN 'TRADE_LICENCE'      THEN 'TRADE_LICENCE'::"RegistrationDocumentType"
         WHEN 'GST_CERTIFICATES'   THEN 'GST_CERTIFICATE'::"RegistrationDocumentType"
         WHEN 'GST_CERTIFICATESS'  THEN 'GST_CERTIFICATE'::"RegistrationDocumentType"
         ELSE NULL
       END
  FROM "DocumentTypes" dt
 WHERE dt.id = ad.document_type_id;

ALTER TABLE "ApplicationDocuments" ALTER COLUMN "document_type" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "ApplicationDocuments" DROP CONSTRAINT "ApplicationDocuments_document_type_id_fkey";

-- DropIndex
DROP INDEX "ApplicationDocuments_application_id_document_type_id_idx";

-- AlterTable
ALTER TABLE "ApplicationDocuments" DROP COLUMN "document_type_id";

-- CreateIndex
CREATE INDEX "ApplicationDocuments_application_id_document_type_idx" ON "ApplicationDocuments"("application_id", "document_type");

COMMENT ON COLUMN "ApplicationDocuments"."document_type" IS 'Which of the three fixed registration KYC requirements this file satisfies (spec D-3). Not a foreign key.';
