-- Membership plans, told apart by their term.
--
-- The association publishes several "new membership" prices at once — 12, 24 and
-- 36 months, each at its own amount — and the applicant picks one on the
-- membership page. Two changes make that possible.

-- 1. The overlap guard ignored `duration_months`, which is the one column that
--    made those three rows different. Keyed on (category, tier, fee_type, dates)
--    alone, a 24-month price looked like a duplicate of the 12-month one and the
--    second insert was refused.
--
--    Adding the term to the key lets the three coexist while keeping the rule
--    that matters: two prices for the same thing, over the same term, may not be
--    live at once. `COALESCE(-1)` is kept on the two nullable columns so global
--    rows still collide with each other rather than passing through NULL.
ALTER TABLE "FeeStructures" DROP CONSTRAINT IF EXISTS "FeeStructures_no_overlapping_active_price";

ALTER TABLE "FeeStructures"
  ADD CONSTRAINT "FeeStructures_no_overlapping_active_price"
  EXCLUDE USING gist (
    (COALESCE("category_id", -1)) WITH =,
    (COALESCE("tier_id", -1))     WITH =,
    fee_type                      WITH =,
    duration_months               WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  )
  WHERE ("is_active" AND "deletedAt" IS NULL);

-- 2. Somewhere to record which plan was picked.
--
--    Nullable on purpose. An application started before this existed, or entered
--    by staff on an applicant's behalf, has no choice to record — and activation
--    falls back to resolving a price the old way when this is null, so every
--    application already in flight prices exactly as it did yesterday.
ALTER TABLE "MembershipApplications" ADD COLUMN "fee_structure_id" BIGINT;

ALTER TABLE "MembershipApplications"
  ADD CONSTRAINT "MembershipApplications_fee_structure_id_fkey"
  FOREIGN KEY ("fee_structure_id") REFERENCES "FeeStructures"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Retiring a price must not orphan the applications that chose it, so the FK is
-- SET NULL rather than RESTRICT; this index keeps that sweep cheap.
CREATE INDEX "MembershipApplications_fee_structure_id_idx"
  ON "MembershipApplications"("fee_structure_id");
