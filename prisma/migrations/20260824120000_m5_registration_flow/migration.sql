-- M5 registration flow: location + company-type masters, multi-select categories,
-- deferred password, PENDING_APPROVAL user status.
-- Enum value added in prior migration 20260824115959_m5_user_status_enum.

-- CreateTable
CREATE TABLE "Countries" (
    "id" BIGSERIAL NOT NULL,
    "iso_code" CHAR(2) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "Countries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "States" (
    "id" BIGSERIAL NOT NULL,
    "country_id" BIGINT NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "States_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Cities" (
    "id" BIGSERIAL NOT NULL,
    "state_id" BIGINT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "Cities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MemberCategories" (
    "member_id" BIGINT NOT NULL,
    "category_id" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemberCategories_pkey" PRIMARY KEY ("member_id","category_id")
);

CREATE TABLE "CompanyTypes" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "CompanyTypes_pkey" PRIMARY KEY ("id")
);

-- Preserve legacy single-category members before dropping the column.
INSERT INTO "MemberCategories" ("member_id", "category_id")
SELECT m.id, m.category_id
  FROM "Members" m
 WHERE m.category_id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM "MemberCategories" mc
          WHERE mc.member_id = m.id AND mc.category_id = m.category_id
       );

-- DropForeignKey
ALTER TABLE "Members" DROP CONSTRAINT IF EXISTS "Members_category_id_fkey";
ALTER TABLE "Members" DROP CONSTRAINT IF EXISTS "Members_tier_id_fkey";

-- DropIndex
DROP INDEX IF EXISTS "Members_category_id_tier_id_idx";
DROP INDEX IF EXISTS "Members_status_category_id_createdAt_idx";

-- AlterTable
ALTER TABLE "FeeStructures" ALTER COLUMN "category_id" DROP NOT NULL;

ALTER TABLE "MemberAddresses"
  ADD COLUMN "city_id" BIGINT,
  ADD COLUMN "country_id" BIGINT,
  ADD COLUMN "state_id" BIGINT;

ALTER TABLE "Members"
  DROP COLUMN "business_type",
  DROP COLUMN "category_id",
  DROP COLUMN "tier_id",
  ADD COLUMN "company_category" BOOLEAN,
  ADD COLUMN "company_type_id" BIGINT,
  ADD COLUMN "consent_accepted_at" TIMESTAMPTZ(6),
  ADD COLUMN "consent_ip" VARCHAR(45),
  ADD COLUMN "gstin_holder" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "landline" VARCHAR(20);

ALTER TABLE "Users"
  ALTER COLUMN "password_hash" DROP NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';

-- CreateIndex
CREATE UNIQUE INDEX "Countries_iso_code_key" ON "Countries"("iso_code");
CREATE INDEX "Countries_is_active_display_order_idx" ON "Countries"("is_active", "display_order");
CREATE INDEX "States_country_id_name_idx" ON "States"("country_id", "name");
CREATE UNIQUE INDEX "States_country_id_code_key" ON "States"("country_id", "code");
CREATE INDEX "Cities_state_id_name_idx" ON "Cities"("state_id", "name");
CREATE UNIQUE INDEX "Cities_state_id_name_key" ON "Cities"("state_id", "name");
CREATE INDEX "MemberCategories_category_id_idx" ON "MemberCategories"("category_id");
CREATE UNIQUE INDEX "CompanyTypes_code_key" ON "CompanyTypes"("code");
CREATE INDEX "CompanyTypes_is_active_display_order_idx" ON "CompanyTypes"("is_active", "display_order");
CREATE INDEX "Members_status_createdAt_idx" ON "Members"("status", "createdAt" DESC);
CREATE INDEX "Members_company_type_id_idx" ON "Members"("company_type_id");

-- AddForeignKey
ALTER TABLE "States" ADD CONSTRAINT "States_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "Countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Cities" ADD CONSTRAINT "Cities_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "States"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Members" ADD CONSTRAINT "Members_company_type_id_fkey" FOREIGN KEY ("company_type_id") REFERENCES "CompanyTypes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberAddresses" ADD CONSTRAINT "MemberAddresses_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "Countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberAddresses" ADD CONSTRAINT "MemberAddresses_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "States"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberAddresses" ADD CONSTRAINT "MemberAddresses_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "Cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MemberCategories" ADD CONSTRAINT "MemberCategories_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MemberCategories" ADD CONSTRAINT "MemberCategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "MembershipCategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fee overlap guard: nullable category_id — COALESCE so two global rows collide.
ALTER TABLE "FeeStructures" DROP CONSTRAINT IF EXISTS "FeeStructures_no_overlapping_active_price";

ALTER TABLE "FeeStructures"
  ADD CONSTRAINT "FeeStructures_no_overlapping_active_price"
  EXCLUDE USING gist (
    (COALESCE("category_id", -1)) WITH =,
    (COALESCE("tier_id", -1))     WITH =,
    fee_type                      WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  )
  WHERE ("is_active" AND "deletedAt" IS NULL);

-- Fixed registration KYC types (admin does not manage these — spec D-3).
INSERT INTO "DocumentTypes" ("code", "name", "applies_to", "is_required", "display_order", "is_active", "updatedAt")
VALUES
  ('GST_CERTIFICATE', 'GST certificate', 'APPLICATION', true, 1, true, CURRENT_TIMESTAMP),
  ('PAN_DOCUMENT',    'PAN document',    'APPLICATION', true, 2, true, CURRENT_TIMESTAMP),
  ('TRADE_LICENCE',   'Trade licence',   'APPLICATION', true, 3, true, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
  SET "name" = EXCLUDED."name",
      "applies_to" = EXCLUDED."applies_to",
      "is_required" = EXCLUDED."is_required",
      "display_order" = EXCLUDED."display_order",
      "is_active" = EXCLUDED."is_active",
      "updatedAt" = CURRENT_TIMESTAMP;

-- Table & column comments (ADR-013)
COMMENT ON TABLE  "Countries"        IS 'Country master for the registration form''s cascading location selects.';
COMMENT ON TABLE  "States"           IS 'State master, scoped to a country.';
COMMENT ON TABLE  "Cities"           IS 'City master, scoped to a state.';
COMMENT ON TABLE  "CompanyTypes"     IS 'Legal form of a member firm: Proprietary, Partnership, Private Ltd., Public Ltd.';
COMMENT ON TABLE  "MemberCategories" IS 'Categories a member claims — the registration form''s Business Nature checkboxes. Many per member.';

COMMENT ON COLUMN "Members"."company_type_id"     IS 'FK to CompanyTypes.id — the firm''s legal form.';
COMMENT ON COLUMN "Members"."gstin_holder"        IS 'Whether the firm holds a GSTIN; false means gst_number was submitted as N/A.';
COMMENT ON COLUMN "Members"."company_category"    IS 'Reference form''s Company Category Yes/No, captured verbatim. Meaning undefined (spec OQ-R1); nothing reads it.';
COMMENT ON COLUMN "Members"."landline"            IS 'Landline number, distinct from the primary user''s mobile.';
COMMENT ON COLUMN "Members"."consent_accepted_at" IS 'When the data-processing consent box was ticked at registration.';
COMMENT ON COLUMN "Members"."consent_ip"          IS 'IP the consent was given from.';
COMMENT ON COLUMN "MemberAddresses"."country_id"  IS 'FK to Countries.id. The country text column is kept as the snapshot.';
COMMENT ON COLUMN "MemberAddresses"."state_id"    IS 'FK to States.id. The state text column is kept as the snapshot.';
COMMENT ON COLUMN "MemberAddresses"."city_id"     IS 'FK to Cities.id. The city text column is kept as the snapshot.';
COMMENT ON COLUMN "FeeStructures"."category_id"   IS 'FK to MembershipCategories.id, or NULL for the association-wide price.';
COMMENT ON COLUMN "Users"."password_hash"         IS 'bcrypt hash, or NULL until the member sets their first password after admin approval.';
