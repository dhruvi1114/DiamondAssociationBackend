-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('NEW_MEMBERSHIP', 'RENEWAL', 'EVENT_DEFAULT');

-- CreateEnum
CREATE TYPE "DocumentAppliesTo" AS ENUM ('APPLICATION', 'MEMBER', 'BOTH');

-- CreateTable
CREATE TABLE "MembershipCategories" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MembershipCategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipTiers" (
    "id" BIGSERIAL NOT NULL,
    "category_id" BIGINT NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "MembershipTiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeStructures" (
    "id" BIGSERIAL NOT NULL,
    "category_id" BIGINT NOT NULL,
    "tier_id" BIGINT,
    "fee_type" "FeeType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "duration_months" INTEGER NOT NULL DEFAULT 12,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "FeeStructures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTypes" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "applies_to" "DocumentAppliesTo" NOT NULL DEFAULT 'BOTH',
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "max_size_mb" INTEGER NOT NULL DEFAULT 10,
    "allowed_mime" TEXT[] DEFAULT ARRAY['application/pdf', 'image/jpeg', 'image/png']::TEXT[],
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DocumentTypes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MembershipCategories_code_key" ON "MembershipCategories"("code");

-- CreateIndex
CREATE INDEX "MembershipCategories_is_active_display_order_idx" ON "MembershipCategories"("is_active", "display_order");

-- CreateIndex
CREATE INDEX "MembershipTiers_category_id_display_order_idx" ON "MembershipTiers"("category_id", "display_order");

-- CreateIndex
CREATE INDEX "FeeStructures_category_id_tier_id_fee_type_effective_from_idx" ON "FeeStructures"("category_id", "tier_id", "fee_type", "effective_from" DESC);

-- CreateIndex
CREATE INDEX "FeeStructures_is_active_effective_from_idx" ON "FeeStructures"("is_active", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTypes_code_key" ON "DocumentTypes"("code");

-- CreateIndex
CREATE INDEX "DocumentTypes_applies_to_is_active_display_order_idx" ON "DocumentTypes"("applies_to", "is_active", "display_order");

-- AddForeignKey
ALTER TABLE "MembershipTiers" ADD CONSTRAINT "MembershipTiers_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "MembershipCategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeStructures" ADD CONSTRAINT "FeeStructures_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "MembershipCategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeStructures" ADD CONSTRAINT "FeeStructures_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "MembershipTiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Business rules the database enforces itself (database-design.md §H, §I).
-- Application validation is a courtesy; these are the guarantees.
-- ---------------------------------------------------------------------------

-- A tier's code is unique within its category, not globally: two categories may
-- both have a GOLD. Partial, because a soft-deleted tier must not block re-use.
CREATE UNIQUE INDEX "MembershipTiers_category_code_active_key"
  ON "MembershipTiers" (category_id, code)
  WHERE "deletedAt" IS NULL;

-- Money is never negative, and a percentage is a percentage.
ALTER TABLE "FeeStructures" ADD CONSTRAINT "FeeStructures_amount_nonnegative" CHECK (amount >= 0);
ALTER TABLE "FeeStructures" ADD CONSTRAINT "FeeStructures_tax_rate_range" CHECK (tax_rate >= 0 AND tax_rate <= 100);
ALTER TABLE "FeeStructures" ADD CONSTRAINT "FeeStructures_duration_positive" CHECK (duration_months > 0);

-- An open-ended price has no end date; a closed one ends after it starts.
ALTER TABLE "FeeStructures" ADD CONSTRAINT "FeeStructures_effective_range"
  CHECK (effective_to IS NULL OR effective_to > effective_from);

-- Upload ceilings that are neither zero nor absurd (file-storage.md §3).
ALTER TABLE "DocumentTypes" ADD CONSTRAINT "DocumentTypes_max_size_range"
  CHECK (max_size_mb >= 1 AND max_size_mb <= 50);

-- A document type with no permitted MIME type would accept nothing and read as a
-- configuration bug at upload time instead of at configuration time.
ALTER TABLE "DocumentTypes" ADD CONSTRAINT "DocumentTypes_mime_not_empty"
  CHECK (array_length(allowed_mime, 1) >= 1);

-- Two active prices for the same (category, tier, fee_type) may not overlap in time —
-- otherwise "the" price for a date is ambiguous and the resolver's answer depends on
-- row order. btree_gist (enabled in M0) lets one exclusion constraint state that.
-- COALESCE(tier_id, -1) so category-wide rows (NULL tier) compare equal to each other.
-- fee_type is compared as the enum itself: casting it to text fails with "functions in
-- index expression must be marked IMMUTABLE", because an enum->text cast is only STABLE.
-- btree_gist supports enum types directly, so no cast is needed.
ALTER TABLE "FeeStructures" ADD CONSTRAINT "FeeStructures_no_overlapping_active_price"
  EXCLUDE USING gist (
    category_id WITH =,
    COALESCE(tier_id, -1) WITH =,
    fee_type WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (is_active AND "deletedAt" IS NULL);
-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "MembershipCategories" IS 'A class of membership — the federation''s own vocabulary for the kind of company joining (grower, manufacturer, trader, …). Deactivated rather than deleted once anything references it, so historic members and invoices stay resolvable.';
COMMENT ON COLUMN "MembershipCategories"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MembershipCategories"."code" IS 'Stable machine name, e.g. GROWER. Used by seeds, imports and the fee resolver; never shown to a member. Immutable once created — renaming it would orphan references.';
COMMENT ON COLUMN "MembershipCategories"."name" IS 'Display name shown to applicants and admins, e.g. "Grower".';
COMMENT ON COLUMN "MembershipCategories"."description" IS 'Optional explanation shown on the public membership page to help an applicant self-select.';
COMMENT ON COLUMN "MembershipCategories"."display_order" IS 'Sort position in listings and on the application form. Lower first.';
COMMENT ON COLUMN "MembershipCategories"."is_active" IS 'Whether new applications may choose this category. Existing members keep theirs regardless.';
COMMENT ON COLUMN "MembershipCategories"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MembershipCategories"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MembershipCategories"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "MembershipTiers" IS 'An optional band inside a category (Gold / Silver, Founder / Ordinary). A category with no tiers is priced by its category-wide fee row; a category with tiers can price each one.';
COMMENT ON COLUMN "MembershipTiers"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MembershipTiers"."category_id" IS 'FK to MembershipCategories.id — the category this tier belongs to. ON DELETE RESTRICT: a tier must never outlive its category.';
COMMENT ON COLUMN "MembershipTiers"."code" IS 'Stable machine name, unique within the category, e.g. GOLD.';
COMMENT ON COLUMN "MembershipTiers"."name" IS 'Display name shown to applicants and admins, e.g. "Gold".';
COMMENT ON COLUMN "MembershipTiers"."description" IS 'Optional explanation of what this tier includes.';
COMMENT ON COLUMN "MembershipTiers"."display_order" IS 'Sort position within the category. Lower first.';
COMMENT ON COLUMN "MembershipTiers"."is_active" IS 'Whether new applications may choose this tier.';
COMMENT ON COLUMN "MembershipTiers"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MembershipTiers"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MembershipTiers"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "FeeStructures" IS 'One price, valid for a date range. Resolution (billing-payment.md §2): a tier-specific row beats a category-wide one, and among equals the newest effective_from wins. Rows are never edited once they have priced an invoice — a price change is a new row with a new effective_from, which is what keeps last year''s invoice explainable.';
COMMENT ON COLUMN "FeeStructures"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "FeeStructures"."category_id" IS 'FK to MembershipCategories.id — the category being priced. ON DELETE RESTRICT: historic pricing must stay resolvable.';
COMMENT ON COLUMN "FeeStructures"."tier_id" IS 'FK to MembershipTiers.id, or NULL for a price that covers the whole category. ON DELETE RESTRICT, same reason.';
COMMENT ON COLUMN "FeeStructures"."fee_type" IS 'What this price is for: new membership, renewal, or a default event fee.';
COMMENT ON COLUMN "FeeStructures"."amount" IS 'Amount before tax, INR, 2 decimal places. Never a float (ADR-007). CHECK amount >= 0.';
COMMENT ON COLUMN "FeeStructures"."tax_rate" IS 'Tax percentage applied on top, e.g. 18.00 for 18% GST. 0 when the association does not charge tax on this fee. CHECK between 0 and 100.';
COMMENT ON COLUMN "FeeStructures"."currency" IS 'ISO-4217 currency code. INR only for now (assumption A-3); the column exists so a second currency is a data change rather than a migration.';
COMMENT ON COLUMN "FeeStructures"."duration_months" IS 'How many months of membership this fee buys. Drives the term''s valid_till in M4/M6.';
COMMENT ON COLUMN "FeeStructures"."effective_from" IS 'First date this price applies, inclusive.';
COMMENT ON COLUMN "FeeStructures"."effective_to" IS 'Last date this price applies, inclusive. NULL means open-ended. CHECK effective_to IS NULL OR effective_to > effective_from.';
COMMENT ON COLUMN "FeeStructures"."is_active" IS 'Whether the resolver may pick this row. Lets an admin retire a price without deleting it.';
COMMENT ON COLUMN "FeeStructures"."notes" IS 'Optional internal note, e.g. the committee resolution that set this price. Never shown to members.';
COMMENT ON COLUMN "FeeStructures"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "FeeStructures"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "FeeStructures"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';
-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "DocumentTypes" IS 'A kind of document the platform asks for — GST certificate, IEC certificate, trade licence. The list is configuration, not code: the federation''s real requirements are OQ-9, so this ships empty and is filled from the admin UI.';
COMMENT ON COLUMN "DocumentTypes"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "DocumentTypes"."code" IS 'Stable machine name, e.g. GST_CERTIFICATE. Referenced by uploads and checklists.';
COMMENT ON COLUMN "DocumentTypes"."name" IS 'Display name shown to members on the upload checklist, e.g. "GST certificate".';
COMMENT ON COLUMN "DocumentTypes"."description" IS 'Optional guidance shown next to the upload control — what a valid document looks like.';
COMMENT ON COLUMN "DocumentTypes"."applies_to" IS 'Whether this document is asked for on the application, on the member profile, or both.';
COMMENT ON COLUMN "DocumentTypes"."is_required" IS 'Whether an application cannot be submitted without it. Optional documents still upload.';
COMMENT ON COLUMN "DocumentTypes"."max_size_mb" IS 'Upload size ceiling in megabytes, enforced before the file is buffered (file-storage.md §3). CHECK between 1 and 50.';
COMMENT ON COLUMN "DocumentTypes"."allowed_mime" IS 'Permitted MIME types. The upload also sniffs magic bytes, because a client-declared Content-Type is not evidence (file-storage.md §3).';
COMMENT ON COLUMN "DocumentTypes"."display_order" IS 'Sort position on the checklist. Lower first.';
COMMENT ON COLUMN "DocumentTypes"."is_active" IS 'Whether this type is offered for new uploads. Existing documents keep their type.';
COMMENT ON COLUMN "DocumentTypes"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "DocumentTypes"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "DocumentTypes"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';
