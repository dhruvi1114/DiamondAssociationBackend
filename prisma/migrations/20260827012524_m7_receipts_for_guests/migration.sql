-- Receipts can name a guest, not only a member.
--
-- A non-member who pays for an event gets a payment and a confirmed booking but
-- no receipt document, because this column was NOT NULL. The same either-or
-- pattern as Invoices and Payments closes that gap.
--
-- The existing receipt keeps its member; the CHECK is verified against it before
-- this transaction commits.

BEGIN;

-- DropForeignKey
ALTER TABLE "Receipts" DROP CONSTRAINT "Receipts_member_id_fkey";

-- AlterTable
ALTER TABLE "Receipts" ADD COLUMN     "guest_registrant_id" BIGINT,
ALTER COLUMN "member_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Receipts" ADD CONSTRAINT "Receipts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipts" ADD CONSTRAINT "Receipts_guest_registrant_id_fkey" FOREIGN KEY ("guest_registrant_id") REFERENCES "GuestRegistrants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "Receipts" ADD CONSTRAINT "Receipts_member_or_guest"
  CHECK (("member_id" IS NOT NULL) <> ("guest_registrant_id" IS NOT NULL));

COMMENT ON COLUMN "Receipts"."member_id" IS 'FK to Members.id — who paid, when the payer is a member. Nullable because a non-member may pay for an event.';
COMMENT ON COLUMN "Receipts"."guest_registrant_id" IS 'FK to GuestRegistrants.id — who paid, when the payer is not a member.';

COMMIT;
