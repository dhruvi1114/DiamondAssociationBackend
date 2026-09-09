-- Who ended a refund: rejected it, sent it, or marked it failed.
--
-- One column, not three. Those three outcomes are mutually exclusive and
-- "status" already says which happened, so three columns would only ever hold
-- one value between them and give three chances to disagree about it.
--
-- Deliberately separate from "updated_by_admin_id", which means "who touched
-- this last" and is overwritten by any later edit. Money leaving the account
-- needs a record that stays true.
ALTER TABLE "Refunds"
  ADD COLUMN "finalised_by_admin_id" BIGINT;

ALTER TABLE "Refunds"
  ADD CONSTRAINT "Refunds_finalised_by_admin_id_fkey"
  FOREIGN KEY ("finalised_by_admin_id") REFERENCES "AdminUsers"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- The two existing actor columns were plain BIGINTs with nothing enforcing that
-- they pointed at a real account. The queue now shows the names they resolve
-- to, so an id with no row behind it would render as a blank nobody can explain.
ALTER TABLE "Refunds"
  ADD CONSTRAINT "Refunds_requested_by_admin_id_fkey"
  FOREIGN KEY ("requested_by_admin_id") REFERENCES "AdminUsers"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "Refunds"
  ADD CONSTRAINT "Refunds_approved_by_admin_id_fkey"
  FOREIGN KEY ("approved_by_admin_id") REFERENCES "AdminUsers"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "Refunds_finalised_by_admin_id_idx" ON "Refunds"("finalised_by_admin_id");

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Added after the fact: this migration shipped without them, which left the
-- db:check-comments gate red and therefore unable to catch the NEXT omission.
-- ============================================================================

COMMENT ON COLUMN "Refunds"."finalised_by_admin_id" IS 'Staff account that ended it — rejected it, sent it, or marked it failed. One column rather than three because those three outcomes are mutually exclusive: `status` says which of them happened, and three columns that can never be populated together would be three chances to disagree about it. Kept apart from `updated_by_admin_id`, which is only ever "who touched this last" and would be overwritten by any later edit.';
