-- Repair the comment debt on the M5 master tables.
--
-- ADR-013 requires a COMMENT ON for every table and column, and
-- `npm run db:check-comments` gates it. Countries, States, Cities, CompanyTypes
-- and MemberCategories were created without the SQL half, so the gate has been
-- red — which also means the schema suite of the self-test harness fails, and a
-- permanently red check is one nobody reads.
--
-- Nothing here is invented: every sentence is generated from the `///`
-- doc-comments already in prisma/schema by scripts/emit-db-comments.ts, so the
-- Prisma schema and the database now say the same thing.
--
-- Comments belong in the migration that creates the object. These objects are
-- already created and applied, so fixing forward is the only route left — the
-- same exception taken for Receipts, and for the same reason.
--
-- Metadata only. No table, column or row is touched.

BEGIN;

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "Countries" IS 'A country. Seeded, rarely edited, never deleted once an address references it.';
COMMENT ON COLUMN "Countries"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Countries"."iso_code" IS 'ISO-3166-1 alpha-2, e.g. IN. Unique; this is the stable machine name.';
COMMENT ON COLUMN "Countries"."name" IS 'Display name, e.g. India.';
COMMENT ON COLUMN "Countries"."display_order" IS 'Sort position. Lower first, so India can sit at the top of an Indian form.';
COMMENT ON COLUMN "Countries"."is_active" IS 'Whether the registration form may offer it.';
COMMENT ON COLUMN "Countries"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Countries"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Countries"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "States" IS 'A state or province inside a country.';
COMMENT ON COLUMN "States"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "States"."country_id" IS 'FK to Countries.id. ON DELETE RESTRICT — a state must not outlive its country.';
COMMENT ON COLUMN "States"."code" IS 'Short code, unique within the country, e.g. GJ.';
COMMENT ON COLUMN "States"."name" IS 'Display name, e.g. Gujarat.';
COMMENT ON COLUMN "States"."is_active" IS 'Whether the registration form may offer it.';
COMMENT ON COLUMN "States"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "States"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "States"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "Cities" IS 'A city or town inside a state.';
COMMENT ON COLUMN "Cities"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Cities"."state_id" IS 'FK to States.id. ON DELETE RESTRICT.';
COMMENT ON COLUMN "Cities"."name" IS 'Display name, e.g. Surat.';
COMMENT ON COLUMN "Cities"."is_active" IS 'Whether the registration form may offer it.';
COMMENT ON COLUMN "Cities"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Cities"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Cities"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "MemberCategories" IS 'A category a member claims. The many-to-many behind the registration form''s "Business Nature" checkboxes.';
COMMENT ON COLUMN "MemberCategories"."member_id" IS 'FK to Members.id. ON DELETE CASCADE — a claim is meaningless without its firm.';
COMMENT ON COLUMN "MemberCategories"."category_id" IS 'FK to MembershipCategories.id. ON DELETE RESTRICT.';
COMMENT ON COLUMN "MemberCategories"."createdAt" IS 'When the claim was recorded.';

COMMENT ON TABLE "CompanyTypes" IS 'The legal form of a member firm — Proprietary, Partnership, Private Ltd., Public Ltd.';
COMMENT ON COLUMN "CompanyTypes"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "CompanyTypes"."code" IS 'Stable machine name, e.g. PRIVATE_LTD. Immutable once created.';
COMMENT ON COLUMN "CompanyTypes"."name" IS 'Display name shown on the registration form, e.g. "Private Ltd.".';
COMMENT ON COLUMN "CompanyTypes"."display_order" IS 'Sort position on the form. Lower first.';
COMMENT ON COLUMN "CompanyTypes"."is_active" IS 'Whether the registration form may offer it. Existing members keep theirs regardless.';
COMMENT ON COLUMN "CompanyTypes"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "CompanyTypes"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "CompanyTypes"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMIT;
