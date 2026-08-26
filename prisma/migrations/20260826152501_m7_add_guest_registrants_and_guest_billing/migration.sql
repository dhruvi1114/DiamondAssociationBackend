-- M7 — guests, and invoices that can be addressed to one.
--
-- Invoices.member_id becomes nullable so a non-member can be billed for an
-- event. Every existing invoice keeps its member; the CHECK below is verified
-- against them before this transaction commits, so a bad row cannot slip in.
--
-- The FK is dropped and re-added only to change ON DELETE from RESTRICT to
-- NO ACTION, the project's stated preference. Behaviour is identical for a
-- non-deferred constraint; no data is touched.

BEGIN;

-- DropForeignKey
ALTER TABLE "Invoices" DROP CONSTRAINT "Invoices_member_id_fkey";

-- AlterTable
ALTER TABLE "Invoices" ADD COLUMN     "guest_registrant_id" BIGINT,
ALTER COLUMN "member_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Payments" ADD COLUMN     "guest_registrant_id" BIGINT;

-- CreateTable
CREATE TABLE "GuestRegistrants" (
    "id" BIGSERIAL NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "designation" VARCHAR(100),
    "company_name" VARCHAR(200),
    "email" CITEXT NOT NULL,
    "phone" VARCHAR(20),
    "gst_number" VARCHAR(20),
    "pan_number" VARCHAR(10),
    "line1" VARCHAR(200),
    "line2" VARCHAR(200),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "country" VARCHAR(100) NOT NULL DEFAULT 'India',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "GuestRegistrants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuestRegistrants_email_idx" ON "GuestRegistrants"("email");

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_guest_registrant_id_fkey" FOREIGN KEY ("guest_registrant_id") REFERENCES "GuestRegistrants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_guest_registrant_id_fkey" FOREIGN KEY ("guest_registrant_id") REFERENCES "GuestRegistrants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written half: the either-or guard, and comments (ADR-013).
-- ---------------------------------------------------------------------------

-- Exactly one payer, never both, never neither. The same pattern AuthTokens uses
-- for its two audiences and ApprovalRequests for its two subjects.
ALTER TABLE "Invoices" ADD CONSTRAINT "Invoices_member_or_guest"
  CHECK (("member_id" IS NOT NULL) <> ("guest_registrant_id" IS NOT NULL));
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_member_or_guest"
  CHECK (("member_id" IS NOT NULL) <> ("guest_registrant_id" IS NOT NULL));

ALTER TABLE "GuestRegistrants" ADD CONSTRAINT "GuestRegistrants_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "GuestRegistrants" ADD CONSTRAINT "GuestRegistrants_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

COMMENT ON TABLE "GuestRegistrants" IS 'A non-member who registered for a public event. Not a login: no password, no Users row. A guest is the customer of one event, not a platform user.';
COMMENT ON COLUMN "GuestRegistrants"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "GuestRegistrants"."full_name" IS 'The person attending and being billed.';
COMMENT ON COLUMN "GuestRegistrants"."designation" IS 'Job title, for the badge and the attendee list.';
COMMENT ON COLUMN "GuestRegistrants"."company_name" IS 'Their firm''s name, as it should appear on the invoice.';
COMMENT ON COLUMN "GuestRegistrants"."email" IS 'Where the confirmation and the ticket code are sent.';
COMMENT ON COLUMN "GuestRegistrants"."phone" IS 'Day-of contact number.';
COMMENT ON COLUMN "GuestRegistrants"."gst_number" IS 'GSTIN, so the invoice can carry it. Optional: not every guest has one.';
COMMENT ON COLUMN "GuestRegistrants"."pan_number" IS 'PAN, for TDS cases.';
COMMENT ON COLUMN "GuestRegistrants"."line1" IS 'Billing address, line 1.';
COMMENT ON COLUMN "GuestRegistrants"."line2" IS 'Billing address, line 2.';
COMMENT ON COLUMN "GuestRegistrants"."city" IS 'City.';
COMMENT ON COLUMN "GuestRegistrants"."state" IS 'State.';
COMMENT ON COLUMN "GuestRegistrants"."pincode" IS 'Postal code.';
COMMENT ON COLUMN "GuestRegistrants"."country" IS 'Country.';
COMMENT ON COLUMN "GuestRegistrants"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "GuestRegistrants"."created_by_user_id" IS 'Member login that created this row. Always NULL: guests have no login.';
COMMENT ON COLUMN "GuestRegistrants"."created_by_admin_id" IS 'Staff account that created this row, when staff registered someone by hand.';
COMMENT ON COLUMN "GuestRegistrants"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "GuestRegistrants"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "GuestRegistrants"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMENT ON COLUMN "Invoices"."member_id" IS 'FK to Members.id — who is billed, when the payer is a member. Nullable because a non-member may be billed for an event; exactly one of this and guest_registrant_id is set.';
COMMENT ON COLUMN "Invoices"."guest_registrant_id" IS 'FK to GuestRegistrants.id — who is billed, when the payer is not a member.';
COMMENT ON COLUMN "Payments"."guest_registrant_id" IS 'FK to GuestRegistrants.id — who paid, when the payer is not a member.';

COMMIT;
