-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('DRAFT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('REGISTERED', 'FACTORY', 'CORRESPONDENCE');

-- CreateEnum
CREATE TYPE "DocumentVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Members" (
    "id" BIGSERIAL NOT NULL,
    "member_code" VARCHAR(30),
    "primary_user_id" BIGINT NOT NULL,
    "category_id" BIGINT,
    "tier_id" BIGINT,
    "company_name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(200),
    "business_type" VARCHAR(100),
    "iec_code" VARCHAR(20),
    "gst_number" VARCHAR(20),
    "pan_number" VARCHAR(15),
    "trade_license_no" VARCHAR(50),
    "website" VARCHAR(200),
    "about" TEXT,
    "logo_path" TEXT,
    "status" "MemberStatus" NOT NULL DEFAULT 'DRAFT',
    "directory_visible" BOOLEAN NOT NULL DEFAULT true,
    "joined_on" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberContacts" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "designation" VARCHAR(100),
    "email" VARCHAR(150),
    "phone" VARCHAR(20),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MemberContacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberAddresses" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "address_type" "AddressType" NOT NULL DEFAULT 'REGISTERED',
    "line1" VARCHAR(200) NOT NULL,
    "line2" VARCHAR(200),
    "city" VARCHAR(100) NOT NULL,
    "state" VARCHAR(100) NOT NULL,
    "country" VARCHAR(100) NOT NULL DEFAULT 'India',
    "pincode" VARCHAR(10) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MemberAddresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberDocuments" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "document_type_id" BIGINT NOT NULL,
    "file_path" TEXT NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "verification_status" "DocumentVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verified_by_admin_id" BIGINT,
    "verified_at" TIMESTAMPTZ(6),
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MemberDocuments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberProfileChangeRequests" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "requested_by_user_id" BIGINT NOT NULL,
    "changes_json" JSONB NOT NULL,
    "reason" TEXT,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_admin_id" BIGINT,
    "decided_at" TIMESTAMPTZ(6),
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MemberProfileChangeRequests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberStatusHistory" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "from_status" "MemberStatus",
    "to_status" "MemberStatus" NOT NULL,
    "reason" TEXT,
    "changed_by_admin_id" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Members_member_code_key" ON "Members"("member_code");

-- CreateIndex
CREATE UNIQUE INDEX "Members_primary_user_id_key" ON "Members"("primary_user_id");

-- CreateIndex
CREATE INDEX "Members_status_category_id_createdAt_idx" ON "Members"("status", "category_id", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Members_category_id_tier_id_idx" ON "Members"("category_id", "tier_id");

-- CreateIndex
CREATE INDEX "Members_directory_visible_status_idx" ON "Members"("directory_visible", "status");

-- CreateIndex
CREATE INDEX "MemberContacts_member_id_idx" ON "MemberContacts"("member_id");

-- CreateIndex
CREATE INDEX "MemberAddresses_member_id_address_type_idx" ON "MemberAddresses"("member_id", "address_type");

-- CreateIndex
CREATE INDEX "MemberDocuments_member_id_document_type_id_idx" ON "MemberDocuments"("member_id", "document_type_id");

-- CreateIndex
CREATE INDEX "MemberDocuments_verification_status_idx" ON "MemberDocuments"("verification_status");

-- CreateIndex
CREATE INDEX "MemberProfileChangeRequests_member_id_status_idx" ON "MemberProfileChangeRequests"("member_id", "status");

-- CreateIndex
CREATE INDEX "MemberProfileChangeRequests_status_createdAt_idx" ON "MemberProfileChangeRequests"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MemberStatusHistory_member_id_createdAt_idx" ON "MemberStatusHistory"("member_id", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Members" ADD CONSTRAINT "Members_primary_user_id_fkey" FOREIGN KEY ("primary_user_id") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Members" ADD CONSTRAINT "Members_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "MembershipCategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Members" ADD CONSTRAINT "Members_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "MembershipTiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberContacts" ADD CONSTRAINT "MemberContacts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberAddresses" ADD CONSTRAINT "MemberAddresses_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDocuments" ADD CONSTRAINT "MemberDocuments_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDocuments" ADD CONSTRAINT "MemberDocuments_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "DocumentTypes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberDocuments" ADD CONSTRAINT "MemberDocuments_verified_by_admin_id_fkey" FOREIGN KEY ("verified_by_admin_id") REFERENCES "AdminUsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberProfileChangeRequests" ADD CONSTRAINT "MemberProfileChangeRequests_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberProfileChangeRequests" ADD CONSTRAINT "MemberProfileChangeRequests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberProfileChangeRequests" ADD CONSTRAINT "MemberProfileChangeRequests_decided_by_admin_id_fkey" FOREIGN KEY ("decided_by_admin_id") REFERENCES "AdminUsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberStatusHistory" ADD CONSTRAINT "MemberStatusHistory_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberStatusHistory" ADD CONSTRAINT "MemberStatusHistory_changed_by_admin_id_fkey" FOREIGN KEY ("changed_by_admin_id") REFERENCES "AdminUsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Guarantees the database makes, not just the service (database-design.md §H).
-- ---------------------------------------------------------------------------

-- Identity fields are unique across LIVE members only: a soft-deleted record
-- must not block a company from re-registering with the same GST or IEC.
CREATE UNIQUE INDEX "Members_gst_number_live_key"
  ON "Members" (gst_number) WHERE gst_number IS NOT NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "Members_iec_code_live_key"
  ON "Members" (iec_code) WHERE iec_code IS NOT NULL AND "deletedAt" IS NULL;

-- Exactly one primary contact and one primary address per member. Enforced here
-- because "the address we post to" cannot be ambiguous, and two concurrent edits
-- would otherwise both succeed.
CREATE UNIQUE INDEX "MemberContacts_one_primary_per_member"
  ON "MemberContacts" (member_id) WHERE is_primary AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "MemberAddresses_one_primary_per_member"
  ON "MemberAddresses" (member_id) WHERE is_primary AND "deletedAt" IS NULL;

-- One live upload per (member, document type, version). Re-uploading increments
-- the version rather than replacing the file an approver may already have seen.
CREATE UNIQUE INDEX "MemberDocuments_version_key"
  ON "MemberDocuments" (member_id, document_type_id, version) WHERE "deletedAt" IS NULL;

-- One open change request per member: a queue of competing edits to the same
-- company record is a merge conflict nobody can adjudicate.
CREATE UNIQUE INDEX "MemberProfileChangeRequests_one_open_per_member"
  ON "MemberProfileChangeRequests" (member_id) WHERE status = 'PENDING';

-- A tier must belong to the category the member selected. Without this a member
-- could hold Growers + Gold-from-Manufacturers and price against neither.
ALTER TABLE "Members" ADD CONSTRAINT "Members_tier_requires_category"
  CHECK (tier_id IS NULL OR category_id IS NOT NULL);

-- GSTIN is 15 characters; PAN is 10. Format beyond length is validated in the
-- service, where the message can explain itself.
ALTER TABLE "Members" ADD CONSTRAINT "Members_gst_length"
  CHECK (gst_number IS NULL OR char_length(gst_number) = 15);
ALTER TABLE "Members" ADD CONSTRAINT "Members_pan_length"
  CHECK (pan_number IS NULL OR char_length(pan_number) = 10);

-- Files have a size and a checksum, always.
ALTER TABLE "MemberDocuments" ADD CONSTRAINT "MemberDocuments_size_positive" CHECK (size_bytes > 0);
ALTER TABLE "MemberDocuments" ADD CONSTRAINT "MemberDocuments_version_positive" CHECK (version >= 1);

-- A rejection must say why. A verification decision with no reason is one the
-- member cannot act on (ux-principles.md §5).
ALTER TABLE "MemberDocuments" ADD CONSTRAINT "MemberDocuments_rejection_needs_remarks"
  CHECK (verification_status <> 'REJECTED' OR (remarks IS NOT NULL AND char_length(btrim(remarks)) > 0));
ALTER TABLE "MemberProfileChangeRequests" ADD CONSTRAINT "MemberProfileChangeRequests_rejection_needs_remarks"
  CHECK (status <> 'REJECTED' OR (remarks IS NOT NULL AND char_length(btrim(remarks)) > 0));

-- A status transition must actually transition.
ALTER TABLE "MemberStatusHistory" ADD CONSTRAINT "MemberStatusHistory_real_transition"
  CHECK (from_status IS NULL OR from_status <> to_status);
-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "Members" IS 'A company. One row per organisation, owned by exactly one login (assumption A-2).';
COMMENT ON COLUMN "Members"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Members"."member_code" IS 'Human-facing membership number, e.g. LGDGF/2026/0042. NULL until approval issues one — a draft company has no membership to number.';
COMMENT ON COLUMN "Members"."primary_user_id" IS 'FK to Users.id — the login that owns this company record. ON DELETE RESTRICT: a login may not vanish while a company depends on it.';
COMMENT ON COLUMN "Members"."category_id" IS 'FK to MembershipCategories.id — what the company is applying for or holds. NULL while the applicant has not chosen yet. ON DELETE RESTRICT.';
COMMENT ON COLUMN "Members"."tier_id" IS 'FK to MembershipTiers.id, when the chosen category has tiers. ON DELETE RESTRICT.';
COMMENT ON COLUMN "Members"."company_name" IS 'Trading name, as the member wants it shown in the directory.';
COMMENT ON COLUMN "Members"."legal_name" IS 'Registered legal name, when it differs from the trading name.';
COMMENT ON COLUMN "Members"."business_type" IS 'What the company does — grower, manufacturer, trader. Free text: the federation''s own vocabulary lives in MembershipCategories, and this is the member''s description of themselves.';
COMMENT ON COLUMN "Members"."iec_code" IS 'Importer-Exporter Code. Unique across live members where present.';
COMMENT ON COLUMN "Members"."gst_number" IS 'GSTIN. Unique across live members where present; 15 characters when supplied.';
COMMENT ON COLUMN "Members"."pan_number" IS 'Company PAN. Not unique — a group may share one across entities.';
COMMENT ON COLUMN "Members"."trade_license_no" IS 'Trade licence / shop establishment number.';
COMMENT ON COLUMN "Members"."website" IS 'Public website, shown in the directory.';
COMMENT ON COLUMN "Members"."about" IS 'Short description for the directory listing.';
COMMENT ON COLUMN "Members"."logo_path" IS 'Path of the company logo in the storage adapter, never a public URL.';
COMMENT ON COLUMN "Members"."status" IS 'Lifecycle state. Only ACTIVE members appear in the public directory.';
COMMENT ON COLUMN "Members"."directory_visible" IS 'Whether the member consents to appearing in the directory at all. The association can also hide a member globally; both must be true to list.';
COMMENT ON COLUMN "Members"."joined_on" IS 'Date the membership first became ACTIVE. NULL until then.';
COMMENT ON COLUMN "Members"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Members"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Members"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "MemberContacts" IS 'A person to contact at a member company.';
COMMENT ON COLUMN "MemberContacts"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MemberContacts"."member_id" IS 'FK to Members.id. ON DELETE CASCADE — a contact is meaningless without its company.';
COMMENT ON COLUMN "MemberContacts"."name" IS 'Person''s name.';
COMMENT ON COLUMN "MemberContacts"."designation" IS 'Role at the company, e.g. Director, Accounts.';
COMMENT ON COLUMN "MemberContacts"."email" IS 'Contact email. Not a login — that is Users.email.';
COMMENT ON COLUMN "MemberContacts"."phone" IS 'Contact phone.';
COMMENT ON COLUMN "MemberContacts"."is_primary" IS 'The one person the association writes to by default. Exactly one per member, enforced by a partial unique index.';
COMMENT ON COLUMN "MemberContacts"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MemberContacts"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MemberContacts"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "MemberAddresses" IS 'A postal address for a member company.';
COMMENT ON COLUMN "MemberAddresses"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MemberAddresses"."member_id" IS 'FK to Members.id. ON DELETE CASCADE — owned by the company.';
COMMENT ON COLUMN "MemberAddresses"."address_type" IS 'Which address this is: registered office, factory, or correspondence.';
COMMENT ON COLUMN "MemberAddresses"."line1" IS 'Street address, first line.';
COMMENT ON COLUMN "MemberAddresses"."line2" IS 'Street address, second line.';
COMMENT ON COLUMN "MemberAddresses"."city" IS 'City or town.';
COMMENT ON COLUMN "MemberAddresses"."state" IS 'State or province.';
COMMENT ON COLUMN "MemberAddresses"."country" IS 'Country. Defaults to India; the federation is Gujarat-based.';
COMMENT ON COLUMN "MemberAddresses"."pincode" IS 'Postal code.';
COMMENT ON COLUMN "MemberAddresses"."is_primary" IS 'The address used when only one is needed. One per member.';
COMMENT ON COLUMN "MemberAddresses"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MemberAddresses"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MemberAddresses"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "MemberDocuments" IS 'One uploaded KYC file belonging to a member. Re-uploading does not overwrite: a new row is written with `version + 1` and the old file is kept, because an approver''s decision must stay explainable by the document they actually saw (file-storage.md §5).';
COMMENT ON COLUMN "MemberDocuments"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MemberDocuments"."member_id" IS 'FK to Members.id. ON DELETE CASCADE — owned by the company.';
COMMENT ON COLUMN "MemberDocuments"."document_type_id" IS 'FK to DocumentTypes.id — which requirement this satisfies. ON DELETE RESTRICT: a type still in use cannot be removed.';
COMMENT ON COLUMN "MemberDocuments"."file_path" IS 'Key in the storage adapter, e.g. members/12/kyc/GST_CERTIFICATE/<uuid>.pdf. Never a public URL — downloads go through an authorised endpoint.';
COMMENT ON COLUMN "MemberDocuments"."original_name" IS 'The member''s own filename, shown back to them. Never used to build a path.';
COMMENT ON COLUMN "MemberDocuments"."mime_type" IS 'MIME type confirmed by sniffing the file''s magic bytes, not the upload header.';
COMMENT ON COLUMN "MemberDocuments"."size_bytes" IS 'File size in bytes, checked against the document type''s ceiling before storing.';
COMMENT ON COLUMN "MemberDocuments"."checksum_sha256" IS 'SHA-256 of the stored bytes. Proves integrity after a restore and detects a re-upload of an identical file.';
COMMENT ON COLUMN "MemberDocuments"."version" IS 'Upload sequence for this member and document type, starting at 1.';
COMMENT ON COLUMN "MemberDocuments"."verification_status" IS 'Where this file stands with the association.';
COMMENT ON COLUMN "MemberDocuments"."verified_by_admin_id" IS 'FK to AdminUsers.id — who verified or rejected it. ON DELETE SET NULL.';
COMMENT ON COLUMN "MemberDocuments"."verified_at" IS 'When the verification decision was made.';
COMMENT ON COLUMN "MemberDocuments"."remarks" IS 'Why it was rejected, shown verbatim to the member. Mandatory on rejection.';
COMMENT ON COLUMN "MemberDocuments"."createdAt" IS 'Row creation timestamp (UTC) — when the file was uploaded.';
COMMENT ON COLUMN "MemberDocuments"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MemberDocuments"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "MemberProfileChangeRequests" IS 'A member''s request to change a field they may not edit directly. Non-critical fields (phone, website, about) save immediately. The fields that identify the company to the federation — name, IEC, GST, trade licence — go through an approver, because changing them silently would change who the membership belongs to (assumption A-11).';
COMMENT ON COLUMN "MemberProfileChangeRequests"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."member_id" IS 'FK to Members.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."requested_by_user_id" IS 'FK to Users.id — who asked. ON DELETE RESTRICT, so the request keeps its author.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."changes_json" IS 'The proposed change as { field: { old, new } }. A diff, not relational data — the documented JSON use (database-design.md §H).';
COMMENT ON COLUMN "MemberProfileChangeRequests"."reason" IS 'Why the member is asking. Helps the approver decide without a phone call.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."status" IS 'Where the request stands.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."decided_by_admin_id" IS 'FK to AdminUsers.id — who decided. ON DELETE SET NULL.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."decided_at" IS 'When the decision was made.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."remarks" IS 'The approver''s note, shown verbatim to the member. Mandatory on rejection.';
COMMENT ON COLUMN "MemberProfileChangeRequests"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MemberProfileChangeRequests"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "MemberStatusHistory" IS 'One membership status transition. Append-only: the timeline on a member''s record is assembled from these rows, so they are never edited or removed.';
COMMENT ON COLUMN "MemberStatusHistory"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MemberStatusHistory"."member_id" IS 'FK to Members.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "MemberStatusHistory"."from_status" IS 'Status before the change. NULL for the first row, when the record was created.';
COMMENT ON COLUMN "MemberStatusHistory"."to_status" IS 'Status after the change.';
COMMENT ON COLUMN "MemberStatusHistory"."reason" IS 'Why the status changed, in the actor''s words. Mandatory for suspend, reactivate and terminate.';
COMMENT ON COLUMN "MemberStatusHistory"."changed_by_admin_id" IS 'FK to AdminUsers.id — the staff member responsible. NULL when the platform itself made the change (payment received, term expired). ON DELETE SET NULL.';
COMMENT ON COLUMN "MemberStatusHistory"."createdAt" IS 'When the transition happened (UTC). No updatedAt: these rows never change.';
