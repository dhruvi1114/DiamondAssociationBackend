-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OtpPurpose" ADD VALUE 'GUEST_BOOKING_VERIFY';
ALTER TYPE "OtpPurpose" ADD VALUE 'BOOKING_LOOKUP';

-- AlterTable
ALTER TABLE "GuestRegistrants" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(6),
ADD COLUMN     "linked_member_id" BIGINT;

-- CreateIndex
CREATE INDEX "GuestRegistrants_linked_member_id_idx" ON "GuestRegistrants"("linked_member_id");

-- AddForeignKey
ALTER TABLE "GuestRegistrants" ADD CONSTRAINT "GuestRegistrants_linked_member_id_fkey" FOREIGN KEY ("linked_member_id") REFERENCES "Members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CommentOnColumn
COMMENT ON COLUMN "GuestRegistrants"."email_verified_at" IS 'When the company email was proven by OTP (UTC). NULL means unproven; only a proven row may be linked to a member.';
COMMENT ON COLUMN "GuestRegistrants"."linked_member_id" IS 'Member this guest booking was later recognised as. Visibility only - the registration and invoice rows stay guest-owned.';
