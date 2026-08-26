-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED_FOR_CORRECTION', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('APPROVE', 'REJECT', 'RETURN', 'REASSIGN', 'COMMENT');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'RETURNED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApprovalSubjectType" AS ENUM ('MEMBERSHIP_APPLICATION', 'PROFILE_CHANGE_REQUEST');

-- CreateEnum
CREATE TYPE "TermType" AS ENUM ('NEW', 'RENEWAL');

-- CreateEnum
CREATE TYPE "TermStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('MEMBERSHIP', 'RENEWAL', 'EVENT', 'OTHER');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');

-- AlterTable
ALTER TABLE "Members" ADD COLUMN     "current_term_id" BIGINT;

-- CreateTable
CREATE TABLE "MembershipApplications" (
    "id" BIGSERIAL NOT NULL,
    "application_number" VARCHAR(30),
    "user_id" BIGINT NOT NULL,
    "member_id" BIGINT NOT NULL,
    "category_id" BIGINT NOT NULL,
    "tier_id" BIGINT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "current_stage_id" BIGINT,
    "company_name" VARCHAR(200) NOT NULL,
    "legal_name" VARCHAR(200),
    "business_type" VARCHAR(100),
    "iec_code" VARCHAR(20),
    "gst_number" VARCHAR(20),
    "pan_number" VARCHAR(15),
    "trade_license_no" VARCHAR(50),
    "website" VARCHAR(200),
    "about" TEXT,
    "extra_json" JSONB,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "resubmission_count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MembershipApplications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDocuments" (
    "id" BIGSERIAL NOT NULL,
    "application_id" BIGINT NOT NULL,
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

    CONSTRAINT "ApplicationDocuments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalWorkflows" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "subject_type" "ApprovalSubjectType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ApprovalWorkflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStages" (
    "id" BIGSERIAL NOT NULL,
    "workflow_id" BIGINT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "approver_role_id" BIGINT NOT NULL,
    "is_final" BOOLEAN NOT NULL DEFAULT false,
    "allow_return" BOOLEAN NOT NULL DEFAULT true,
    "sla_hours" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ApprovalStages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequests" (
    "id" BIGSERIAL NOT NULL,
    "workflow_id" BIGINT NOT NULL,
    "subject_type" "ApprovalSubjectType" NOT NULL,
    "application_id" BIGINT,
    "profile_change_request_id" BIGINT,
    "current_stage_id" BIGINT NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ApprovalRequests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalActions" (
    "id" BIGSERIAL NOT NULL,
    "approval_request_id" BIGINT NOT NULL,
    "stage_id" BIGINT NOT NULL,
    "admin_user_id" BIGINT NOT NULL,
    "action" "ApprovalActionType" NOT NULL,
    "from_status" "ApplicationStatus",
    "to_status" "ApplicationStatus",
    "remarks" TEXT,
    "acted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalActions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipTerms" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "category_id" BIGINT NOT NULL,
    "tier_id" BIGINT,
    "term_type" "TermType" NOT NULL DEFAULT 'NEW',
    "valid_from" DATE NOT NULL,
    "valid_till" DATE NOT NULL,
    "status" "TermStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "invoice_id" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MembershipTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoices" (
    "id" BIGSERIAL NOT NULL,
    "invoice_number" VARCHAR(30) NOT NULL,
    "member_id" BIGINT NOT NULL,
    "invoice_type" "InvoiceType" NOT NULL DEFAULT 'MEMBERSHIP',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance_due" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "notes" TEXT,
    "pdf_path" TEXT,
    "created_by_admin_id" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItems" (
    "id" BIGSERIAL NOT NULL,
    "invoice_id" BIGINT NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(14,2) NOT NULL,
    "fee_structure_id" BIGINT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InvoiceItems_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MembershipApplications_application_number_key" ON "MembershipApplications"("application_number");

-- CreateIndex
CREATE INDEX "MembershipApplications_status_submitted_at_idx" ON "MembershipApplications"("status", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "MembershipApplications_current_stage_id_status_idx" ON "MembershipApplications"("current_stage_id", "status");

-- CreateIndex
CREATE INDEX "MembershipApplications_user_id_createdAt_idx" ON "MembershipApplications"("user_id", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MembershipApplications_member_id_idx" ON "MembershipApplications"("member_id");

-- CreateIndex
CREATE INDEX "ApplicationDocuments_application_id_document_type_id_idx" ON "ApplicationDocuments"("application_id", "document_type_id");

-- CreateIndex
CREATE INDEX "ApplicationDocuments_verification_status_idx" ON "ApplicationDocuments"("verification_status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalWorkflows_code_key" ON "ApprovalWorkflows"("code");

-- CreateIndex
CREATE INDEX "ApprovalStages_approver_role_id_idx" ON "ApprovalStages"("approver_role_id");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStages_workflow_id_sequence_key" ON "ApprovalStages"("workflow_id", "sequence");

-- CreateIndex
CREATE INDEX "ApprovalRequests_status_current_stage_id_idx" ON "ApprovalRequests"("status", "current_stage_id");

-- CreateIndex
CREATE INDEX "ApprovalRequests_application_id_idx" ON "ApprovalRequests"("application_id");

-- CreateIndex
CREATE INDEX "ApprovalRequests_profile_change_request_id_idx" ON "ApprovalRequests"("profile_change_request_id");

-- CreateIndex
CREATE INDEX "ApprovalActions_approval_request_id_acted_at_idx" ON "ApprovalActions"("approval_request_id", "acted_at" DESC);

-- CreateIndex
CREATE INDEX "ApprovalActions_admin_user_id_acted_at_idx" ON "ApprovalActions"("admin_user_id", "acted_at" DESC);

-- CreateIndex
CREATE INDEX "MembershipTerms_member_id_valid_till_idx" ON "MembershipTerms"("member_id", "valid_till" DESC);

-- CreateIndex
CREATE INDEX "MembershipTerms_status_valid_till_idx" ON "MembershipTerms"("status", "valid_till");

-- CreateIndex
CREATE UNIQUE INDEX "Invoices_invoice_number_key" ON "Invoices"("invoice_number");

-- CreateIndex
CREATE INDEX "Invoices_member_id_status_issue_date_idx" ON "Invoices"("member_id", "status", "issue_date" DESC);

-- CreateIndex
CREATE INDEX "Invoices_status_due_date_idx" ON "Invoices"("status", "due_date");

-- CreateIndex
CREATE INDEX "Invoices_invoice_type_issue_date_idx" ON "Invoices"("invoice_type", "issue_date" DESC);

-- CreateIndex
CREATE INDEX "InvoiceItems_invoice_id_sort_order_idx" ON "InvoiceItems"("invoice_id", "sort_order");

-- AddForeignKey
ALTER TABLE "MembershipApplications" ADD CONSTRAINT "MembershipApplications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipApplications" ADD CONSTRAINT "MembershipApplications_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipApplications" ADD CONSTRAINT "MembershipApplications_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "MembershipCategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipApplications" ADD CONSTRAINT "MembershipApplications_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "MembershipTiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipApplications" ADD CONSTRAINT "MembershipApplications_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "ApprovalStages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocuments" ADD CONSTRAINT "ApplicationDocuments_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "MembershipApplications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocuments" ADD CONSTRAINT "ApplicationDocuments_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "DocumentTypes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocuments" ADD CONSTRAINT "ApplicationDocuments_verified_by_admin_id_fkey" FOREIGN KEY ("verified_by_admin_id") REFERENCES "AdminUsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStages" ADD CONSTRAINT "ApprovalStages_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "ApprovalWorkflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStages" ADD CONSTRAINT "ApprovalStages_approver_role_id_fkey" FOREIGN KEY ("approver_role_id") REFERENCES "Roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequests" ADD CONSTRAINT "ApprovalRequests_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "ApprovalWorkflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequests" ADD CONSTRAINT "ApprovalRequests_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "MembershipApplications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequests" ADD CONSTRAINT "ApprovalRequests_profile_change_request_id_fkey" FOREIGN KEY ("profile_change_request_id") REFERENCES "MemberProfileChangeRequests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequests" ADD CONSTRAINT "ApprovalRequests_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "ApprovalStages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalActions" ADD CONSTRAINT "ApprovalActions_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "ApprovalRequests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalActions" ADD CONSTRAINT "ApprovalActions_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "ApprovalStages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalActions" ADD CONSTRAINT "ApprovalActions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "AdminUsers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipTerms" ADD CONSTRAINT "MembershipTerms_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipTerms" ADD CONSTRAINT "MembershipTerms_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "MembershipCategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipTerms" ADD CONSTRAINT "MembershipTerms_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "MembershipTiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipTerms" ADD CONSTRAINT "MembershipTerms_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "AdminUsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItems" ADD CONSTRAINT "InvoiceItems_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItems" ADD CONSTRAINT "InvoiceItems_fee_structure_id_fkey" FOREIGN KEY ("fee_structure_id") REFERENCES "FeeStructures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Members" ADD CONSTRAINT "Members_current_term_id_fkey" FOREIGN KEY ("current_term_id") REFERENCES "MembershipTerms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Guarantees the database makes for M4 (database-design.md §C, §D, §H).
-- ---------------------------------------------------------------------------

-- ADR-006: exactly one subject FK, and it must match subject_type. Without this
-- an approval request could point at nothing, or at two things at once.
ALTER TABLE "ApprovalRequests" ADD CONSTRAINT "ApprovalRequests_subject_matches_type"
  CHECK (
    (subject_type = 'MEMBERSHIP_APPLICATION'
      AND application_id IS NOT NULL AND profile_change_request_id IS NULL)
    OR
    (subject_type = 'PROFILE_CHANGE_REQUEST'
      AND profile_change_request_id IS NOT NULL AND application_id IS NULL)
  );

-- One open application per user. A second in-flight application would give the
-- committee two answers to one question.
CREATE UNIQUE INDEX "MembershipApplications_one_open_per_user"
  ON "MembershipApplications" (user_id)
  WHERE status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','RETURNED_FOR_CORRECTION')
    AND "deletedAt" IS NULL;

-- One open approval request per subject.
CREATE UNIQUE INDEX "ApprovalRequests_one_open_per_application"
  ON "ApprovalRequests" (application_id) WHERE status = 'OPEN' AND application_id IS NOT NULL;
CREATE UNIQUE INDEX "ApprovalRequests_one_open_per_change_request"
  ON "ApprovalRequests" (profile_change_request_id)
  WHERE status = 'OPEN' AND profile_change_request_id IS NOT NULL;

-- REJECT and RETURN must carry the reviewer's words. A refusal the applicant
-- cannot act on is worse than no refusal at all.
ALTER TABLE "ApprovalActions" ADD CONSTRAINT "ApprovalActions_decision_needs_remarks"
  CHECK (action NOT IN ('REJECT','RETURN')
         OR (remarks IS NOT NULL AND char_length(btrim(remarks)) > 0));

-- Application evidence: same rules as member KYC.
CREATE UNIQUE INDEX "ApplicationDocuments_version_key"
  ON "ApplicationDocuments" (application_id, document_type_id, version) WHERE "deletedAt" IS NULL;
ALTER TABLE "ApplicationDocuments" ADD CONSTRAINT "ApplicationDocuments_size_positive" CHECK (size_bytes > 0);
ALTER TABLE "ApplicationDocuments" ADD CONSTRAINT "ApplicationDocuments_rejection_needs_remarks"
  CHECK (verification_status <> 'REJECTED'
         OR (remarks IS NOT NULL AND char_length(btrim(remarks)) > 0));

-- A term covers a real span, and a member holds at most one active term.
ALTER TABLE "MembershipTerms" ADD CONSTRAINT "MembershipTerms_span_ordered"
  CHECK (valid_till > valid_from);
CREATE UNIQUE INDEX "MembershipTerms_one_active_per_member"
  ON "MembershipTerms" (member_id) WHERE status = 'ACTIVE';

-- Money. `balance_due` is derived, so the database — not the payment handler —
-- is what guarantees the three columns can never disagree.
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_totals_nonnegative"
  CHECK (subtotal >= 0 AND tax_amount >= 0 AND total_amount >= 0 AND amount_paid >= 0);
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_paid_within_total"
  CHECK (amount_paid <= total_amount);
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_balance_is_derived"
  CHECK (balance_due = total_amount - amount_paid);
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_due_after_issue"
  CHECK (due_date >= issue_date);

ALTER TABLE "InvoiceItems" ADD CONSTRAINT "InvoiceItems_quantity_positive" CHECK (quantity > 0);
ALTER TABLE "InvoiceItems" ADD CONSTRAINT "InvoiceItems_amounts_nonnegative"
  CHECK (unit_price >= 0 AND tax_amount >= 0 AND line_total >= 0);
ALTER TABLE "InvoiceItems" ADD CONSTRAINT "InvoiceItems_tax_rate_range"
  CHECK (tax_rate >= 0 AND tax_rate <= 100);

-- The approval trail is append-only. Revoking UPDATE/DELETE belongs to
-- provisioning (deployment.md §8b) because it needs a non-superuser app role;
-- stated here so the requirement travels with the table that needs it.
COMMENT ON TABLE "ApprovalActions" IS 'APPEND-ONLY: revoke UPDATE and DELETE from the application database role (deployment.md 8b).';
-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "MembershipApplications" IS 'A company''s request to join, and the snapshot of what they submitted. The live company profile lives on Members (ADR-016). The fields here are the **submitted snapshot** — what the approver actually saw — and are never rewritten after submission, so a decision stays explainable a year later.';
COMMENT ON COLUMN "MembershipApplications"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MembershipApplications"."application_number" IS 'Human-facing reference, e.g. APP2026030001. Assigned on submission, so a draft nobody submitted never consumes one.';
COMMENT ON COLUMN "MembershipApplications"."user_id" IS 'FK to Users.id — the login that filed it. ON DELETE RESTRICT: the history keeps its author.';
COMMENT ON COLUMN "MembershipApplications"."member_id" IS 'FK to Members.id — the company record this application belongs to. Created with the draft (ADR-016), so this is never null. ON DELETE CASCADE.';
COMMENT ON COLUMN "MembershipApplications"."category_id" IS 'FK to MembershipCategories.id — the class applied for. ON DELETE RESTRICT.';
COMMENT ON COLUMN "MembershipApplications"."tier_id" IS 'FK to MembershipTiers.id, when the category has bands. ON DELETE RESTRICT.';
COMMENT ON COLUMN "MembershipApplications"."status" IS 'Where the application sits.';
COMMENT ON COLUMN "MembershipApplications"."current_stage_id" IS 'FK to ApprovalStages.id — the stage currently holding it. NULL for a draft or a decided application. ON DELETE SET NULL.';
COMMENT ON COLUMN "MembershipApplications"."company_name" IS 'Trading name as submitted.';
COMMENT ON COLUMN "MembershipApplications"."legal_name" IS 'Registered legal name as submitted.';
COMMENT ON COLUMN "MembershipApplications"."business_type" IS 'Nature of business as submitted.';
COMMENT ON COLUMN "MembershipApplications"."iec_code" IS 'Importer-Exporter Code as submitted.';
COMMENT ON COLUMN "MembershipApplications"."gst_number" IS 'GSTIN as submitted.';
COMMENT ON COLUMN "MembershipApplications"."pan_number" IS 'PAN as submitted.';
COMMENT ON COLUMN "MembershipApplications"."trade_license_no" IS 'Trade licence number as submitted.';
COMMENT ON COLUMN "MembershipApplications"."website" IS 'Website as submitted.';
COMMENT ON COLUMN "MembershipApplications"."about" IS 'The applicant''s description of the company.';
COMMENT ON COLUMN "MembershipApplications"."extra_json" IS 'Free-form extra information the form collects but does not model relationally — a documented JSON use (database-design.md §H).';
COMMENT ON COLUMN "MembershipApplications"."submitted_at" IS 'When it was first submitted. NULL while DRAFT.';
COMMENT ON COLUMN "MembershipApplications"."decided_at" IS 'When it reached a terminal status.';
COMMENT ON COLUMN "MembershipApplications"."resubmission_count" IS 'How many times it has been sent back and resubmitted. Compared against SystemSettings.application.max_resubmissions, which the super admin sets.';
COMMENT ON COLUMN "MembershipApplications"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MembershipApplications"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MembershipApplications"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "ApplicationDocuments" IS 'A file attached to an application. Separate from MemberDocuments rather than one polymorphic table (ADR-006) — the two have different lifecycles, and an application''s evidence must stay frozen with the decision.';
COMMENT ON COLUMN "ApplicationDocuments"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "ApplicationDocuments"."application_id" IS 'FK to MembershipApplications.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "ApplicationDocuments"."document_type_id" IS 'FK to DocumentTypes.id — the requirement it satisfies. ON DELETE RESTRICT.';
COMMENT ON COLUMN "ApplicationDocuments"."file_path" IS 'Storage key. Never a public URL; downloads go through an authorised endpoint.';
COMMENT ON COLUMN "ApplicationDocuments"."original_name" IS 'The applicant''s filename, for display. Never used to build a path.';
COMMENT ON COLUMN "ApplicationDocuments"."mime_type" IS 'MIME type confirmed by sniffing the bytes, not the upload header.';
COMMENT ON COLUMN "ApplicationDocuments"."size_bytes" IS 'Size in bytes, checked against the document type''s ceiling before storing.';
COMMENT ON COLUMN "ApplicationDocuments"."checksum_sha256" IS 'SHA-256 of the stored bytes.';
COMMENT ON COLUMN "ApplicationDocuments"."version" IS 'Upload sequence for this application and type, starting at 1.';
COMMENT ON COLUMN "ApplicationDocuments"."verification_status" IS 'Where this file stands with the reviewer.';
COMMENT ON COLUMN "ApplicationDocuments"."verified_by_admin_id" IS 'FK to AdminUsers.id — who decided. ON DELETE SET NULL.';
COMMENT ON COLUMN "ApplicationDocuments"."verified_at" IS 'When the decision was made.';
COMMENT ON COLUMN "ApplicationDocuments"."remarks" IS 'Why it was rejected, shown verbatim to the applicant. Mandatory on rejection.';
COMMENT ON COLUMN "ApplicationDocuments"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "ApplicationDocuments"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "ApplicationDocuments"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "ApprovalWorkflows" IS 'A named approval process. Seeded; the editor UI arrives in M10.';
COMMENT ON COLUMN "ApprovalWorkflows"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "ApprovalWorkflows"."code" IS 'Stable machine name, e.g. MEMBERSHIP_APPROVAL.';
COMMENT ON COLUMN "ApprovalWorkflows"."name" IS 'Display name for the admin screens.';
COMMENT ON COLUMN "ApprovalWorkflows"."subject_type" IS 'What this workflow governs.';
COMMENT ON COLUMN "ApprovalWorkflows"."is_active" IS 'Whether new requests use it. Retiring a workflow leaves open requests alone.';
COMMENT ON COLUMN "ApprovalWorkflows"."version" IS 'Bumped when the stage list changes, so a request can record which shape it was judged under.';
COMMENT ON COLUMN "ApprovalWorkflows"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "ApprovalWorkflows"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "ApprovalStages" IS 'One step in a workflow, owned by a role. `approver_role_id` is the whole configurability story: who may act on this stage is a role, and which role is data. Moving approval authority is a re-seed, not a deployment.';
COMMENT ON COLUMN "ApprovalStages"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "ApprovalStages"."workflow_id" IS 'FK to ApprovalWorkflows.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "ApprovalStages"."sequence" IS 'Position in the flow, 1-based. Unique within the workflow.';
COMMENT ON COLUMN "ApprovalStages"."name" IS 'What this step is called on screen, e.g. "Document verification".';
COMMENT ON COLUMN "ApprovalStages"."approver_role_id" IS 'FK to Roles.id — the role whose holders may act here. ON DELETE RESTRICT: a role wired into a live stage cannot be deleted.';
COMMENT ON COLUMN "ApprovalStages"."is_final" IS 'Whether approving here approves the whole application.';
COMMENT ON COLUMN "ApprovalStages"."allow_return" IS 'Whether this stage may send the application back to the applicant.';
COMMENT ON COLUMN "ApprovalStages"."sla_hours" IS 'Target turnaround in hours. Surfaced as an "overdue" badge; no automatic escalation in the MVP.';
COMMENT ON COLUMN "ApprovalStages"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "ApprovalStages"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "ApprovalRequests" IS 'One subject travelling through one workflow.';
COMMENT ON COLUMN "ApprovalRequests"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "ApprovalRequests"."workflow_id" IS 'FK to ApprovalWorkflows.id. ON DELETE RESTRICT — history must stay readable.';
COMMENT ON COLUMN "ApprovalRequests"."subject_type" IS 'Which kind of subject this is. Paired with the FK columns below by a CHECK constraint that requires exactly the matching one to be set (ADR-006).';
COMMENT ON COLUMN "ApprovalRequests"."application_id" IS 'FK to MembershipApplications.id when subject_type is MEMBERSHIP_APPLICATION. ON DELETE CASCADE.';
COMMENT ON COLUMN "ApprovalRequests"."profile_change_request_id" IS 'FK to MemberProfileChangeRequests.id when subject_type is PROFILE_CHANGE_REQUEST. ON DELETE CASCADE.';
COMMENT ON COLUMN "ApprovalRequests"."current_stage_id" IS 'FK to ApprovalStages.id — where it is now. ON DELETE RESTRICT.';
COMMENT ON COLUMN "ApprovalRequests"."status" IS 'Lifecycle of this request.';
COMMENT ON COLUMN "ApprovalRequests"."opened_at" IS 'When it entered the workflow.';
COMMENT ON COLUMN "ApprovalRequests"."closed_at" IS 'When it reached a terminal status.';
COMMENT ON COLUMN "ApprovalRequests"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "ApprovalRequests"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "ApprovalActions" IS 'One thing one person did at one stage. Append-only. UPDATE and DELETE are revoked from the application database role (deployment.md §8b) — an approval trail that can be edited is not a trail.';
COMMENT ON COLUMN "ApprovalActions"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "ApprovalActions"."approval_request_id" IS 'FK to ApprovalRequests.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "ApprovalActions"."stage_id" IS 'FK to ApprovalStages.id — where this happened. ON DELETE RESTRICT.';
COMMENT ON COLUMN "ApprovalActions"."admin_user_id" IS 'FK to AdminUsers.id — who did it. ON DELETE RESTRICT: an action must always name a real actor.';
COMMENT ON COLUMN "ApprovalActions"."action" IS 'What they did.';
COMMENT ON COLUMN "ApprovalActions"."from_status" IS 'Application status before the action.';
COMMENT ON COLUMN "ApprovalActions"."to_status" IS 'Application status after the action.';
COMMENT ON COLUMN "ApprovalActions"."remarks" IS 'The reviewer''s words. Mandatory for REJECT and RETURN — a refusal the applicant cannot act on is worse than none. Shown to them verbatim.';
COMMENT ON COLUMN "ApprovalActions"."acted_at" IS 'When it happened (UTC). No updatedAt, no deletedAt: these rows never change.';

COMMENT ON TABLE "MembershipTerms" IS 'One period of membership. A new term per join and per renewal, so the history of what a company held and when is a list of rows rather than a mutated record.';
COMMENT ON COLUMN "MembershipTerms"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MembershipTerms"."member_id" IS 'FK to Members.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "MembershipTerms"."category_id" IS 'FK to MembershipCategories.id — the class held for this term, captured so a later category change does not rewrite history. ON DELETE RESTRICT.';
COMMENT ON COLUMN "MembershipTerms"."tier_id" IS 'FK to MembershipTiers.id — the band held, when applicable. ON DELETE RESTRICT.';
COMMENT ON COLUMN "MembershipTerms"."term_type" IS 'Whether this is the first term or a renewal.';
COMMENT ON COLUMN "MembershipTerms"."valid_from" IS 'First day of cover.';
COMMENT ON COLUMN "MembershipTerms"."valid_till" IS 'Last day of cover. CHECK valid_till > valid_from.';
COMMENT ON COLUMN "MembershipTerms"."status" IS 'Where the term stands. Membership is only ACTIVE once its invoice is paid.';
COMMENT ON COLUMN "MembershipTerms"."invoice_id" IS 'FK to Invoices.id — the invoice that pays for this term. ON DELETE SET NULL: a cancelled invoice must not delete the term it was raised for.';
COMMENT ON COLUMN "MembershipTerms"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MembershipTerms"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "Invoices" IS 'A bill. Immutable after issue except for its payment state — a mistake on an issued invoice is corrected by a credit or a refund, never by an edit.';
COMMENT ON COLUMN "Invoices"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Invoices"."invoice_number" IS 'Human-facing number, format IN + year + calendar quarter + 3-digit sequence restarting each quarter, e.g. IN202603001 (client decision, 2026-08-13).';
COMMENT ON COLUMN "Invoices"."member_id" IS 'FK to Members.id — who is billed. ON DELETE RESTRICT: financial records are never orphaned.';
COMMENT ON COLUMN "Invoices"."invoice_type" IS 'What this invoice is for.';
COMMENT ON COLUMN "Invoices"."status" IS 'Where it stands. PAID and CANCELLED are terminal.';
COMMENT ON COLUMN "Invoices"."issue_date" IS 'Date shown on the invoice.';
COMMENT ON COLUMN "Invoices"."due_date" IS 'Date payment is due. CHECK due_date >= issue_date.';
COMMENT ON COLUMN "Invoices"."subtotal" IS 'Sum of line totals before tax, INR, 2dp. Server-computed; never trusted from a client.';
COMMENT ON COLUMN "Invoices"."tax_amount" IS 'Sum of line taxes, INR, 2dp.';
COMMENT ON COLUMN "Invoices"."total_amount" IS 'Grand total including tax, INR, 2dp.';
COMMENT ON COLUMN "Invoices"."amount_paid" IS 'How much has been received so far, INR, 2dp.';
COMMENT ON COLUMN "Invoices"."balance_due" IS 'total_amount - amount_paid, maintained by the payment handler and enforced by a CHECK so the two can never disagree.';
COMMENT ON COLUMN "Invoices"."currency" IS 'ISO-4217 currency. INR only for now (A-3).';
COMMENT ON COLUMN "Invoices"."notes" IS 'Note printed on the invoice.';
COMMENT ON COLUMN "Invoices"."pdf_path" IS 'Storage key of the rendered PDF. Regenerable; the number never changes.';
COMMENT ON COLUMN "Invoices"."created_by_admin_id" IS 'FK to AdminUsers.id — who raised it, when a person did. NULL when the platform raised it on approval. ON DELETE SET NULL.';
COMMENT ON COLUMN "Invoices"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Invoices"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Invoices"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "InvoiceItems" IS 'One charge on an invoice.';
COMMENT ON COLUMN "InvoiceItems"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "InvoiceItems"."invoice_id" IS 'FK to Invoices.id. ON DELETE CASCADE — lines are owned by their invoice.';
COMMENT ON COLUMN "InvoiceItems"."description" IS 'What the member is being charged for, in their language.';
COMMENT ON COLUMN "InvoiceItems"."quantity" IS 'How many. CHECK quantity > 0.';
COMMENT ON COLUMN "InvoiceItems"."unit_price" IS 'Price per unit before tax, INR, 2dp.';
COMMENT ON COLUMN "InvoiceItems"."tax_rate" IS 'Tax percentage applied to this line, e.g. 18.00.';
COMMENT ON COLUMN "InvoiceItems"."tax_amount" IS 'Tax on this line, INR, 2dp. Computed per line, then summed — never taken on the invoice total, which rounds differently.';
COMMENT ON COLUMN "InvoiceItems"."line_total" IS 'quantity × unit_price + tax_amount, INR, 2dp.';
COMMENT ON COLUMN "InvoiceItems"."fee_structure_id" IS 'FK to FeeStructures.id — the price this line was resolved from, so an invoice can always be traced to the fee that produced it. ON DELETE SET NULL.';
COMMENT ON COLUMN "InvoiceItems"."sort_order" IS 'Display order on the invoice.';
COMMENT ON COLUMN "InvoiceItems"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "InvoiceItems"."updatedAt" IS 'Last modification timestamp (UTC).';

-- Re-stated last so it is the comment that survives: the generator emits the
-- model's doc-comment for this table, and the append-only requirement is an
-- operational instruction that must reach whoever runs \d+ on it.
COMMENT ON TABLE "ApprovalActions" IS 'One decision by one reviewer at one stage. APPEND-ONLY: revoke UPDATE and DELETE from the application database role (deployment.md 8b) — an approval trail that can be edited is not a trail.';

-- New column on an existing table: its comment belongs to the migration that
-- ADDS it, not to the one that created Members (ADR-013).
COMMENT ON COLUMN "Members"."current_term_id" IS 'FK to MembershipTerms.id — the term in force. A nullable pointer, set after the term row exists, which is how the Member ⇄ Term cycle is resolved (database-relationships.md §3). ON DELETE SET NULL.';
