-- Who published a price list, and who last changed it.
--
-- The table carried timestamps and no names. A price list is the sort of record
-- somebody asks about a year later -- "who put this up, and who moved it" -- and
-- a timestamp on its own answers neither question.
ALTER TABLE "FeePlanStructures"
  ADD COLUMN "created_by_admin_id" BIGINT,
  ADD COLUMN "updated_by_admin_id" BIGINT;

ALTER TABLE "FeePlanStructures"
  ADD CONSTRAINT "FeePlanStructures_created_by_admin_id_fkey"
  FOREIGN KEY ("created_by_admin_id") REFERENCES "AdminUsers"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "FeePlanStructures"
  ADD CONSTRAINT "FeePlanStructures_updated_by_admin_id_fkey"
  FOREIGN KEY ("updated_by_admin_id") REFERENCES "AdminUsers"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "FeePlanStructures_created_by_admin_id_idx"
  ON "FeePlanStructures"("created_by_admin_id");

CREATE INDEX "FeePlanStructures_updated_by_admin_id_idx"
  ON "FeePlanStructures"("updated_by_admin_id");
