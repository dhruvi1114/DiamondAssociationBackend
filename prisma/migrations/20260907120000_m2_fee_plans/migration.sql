-- M2 redesign — membership fee plans.
-- Spec: docs/specs/2026-09-07-membership-fee-plans.md
--
-- Purely ADDITIVE. `FeeStructures` and the screen that reads it stay live and untouched: the
-- two shapes coexist until the new screen replaces the old one, and a swap that breaks the
-- working screen on the way is not a swap anyone can review. Nothing is backfilled either —
-- see the note above the tables.

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY');

CREATE TYPE "PriceScope" AS ENUM ('ALL_MEMBERS', 'NEW_MEMBERS_ONLY');

-- ============================================================================
-- Tables
--
-- Both ship EMPTY. The existing FeeStructures rows cannot be migrated in without inventing
-- data: only one RENEWAL row was ever created and it is inactive, so every joining price would
-- need a renewal price guessed for it. A guessed price would silently become what members are
-- billed at renewal, which is the exact failure this redesign exists to remove. The first
-- structure is published from the admin screen instead.
-- ============================================================================

CREATE TABLE "FeePlanStructures" (
  "id"        BIGSERIAL     PRIMARY KEY,
  "name"      VARCHAR(120)  NOT NULL,
  "is_active" BOOLEAN       NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "deletedAt" TIMESTAMPTZ(6)
);

CREATE INDEX "FeePlanStructures_is_active_createdAt_idx"
  ON "FeePlanStructures"("is_active", "createdAt" DESC);

CREATE TABLE "FeePlans" (
  "id"             BIGSERIAL      PRIMARY KEY,
  "structure_id"   BIGINT         NOT NULL,
  "billing_cycle"  "BillingCycle" NOT NULL,
  "name"           VARCHAR(120)   NOT NULL,
  "amount"         DECIMAL(14,2)  NOT NULL,
  "renewal_amount" DECIMAL(14,2)  NOT NULL,
  "tax_rate"       DECIMAL(5,2)   NOT NULL DEFAULT 0,
  "currency"       CHAR(3)        NOT NULL DEFAULT 'INR',
  "effective_from" DATE           NOT NULL,
  "effective_to"   DATE,
  "price_scope"    "PriceScope"   NOT NULL DEFAULT 'ALL_MEMBERS',
  "is_active"      BOOLEAN        NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,
  "deletedAt"      TIMESTAMPTZ(6)
);

ALTER TABLE "FeePlans"
  ADD CONSTRAINT "FeePlans_structure_id_fkey"
  FOREIGN KEY ("structure_id") REFERENCES "FeePlanStructures"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "FeePlans_structure_id_billing_cycle_idx"
  ON "FeePlans"("structure_id", "billing_cycle");

CREATE INDEX "FeePlans_is_active_billing_cycle_effective_from_idx"
  ON "FeePlans"("is_active", "billing_cycle", "effective_from" DESC);

-- ============================================================================
-- The rules, in the database rather than only in the service
-- ============================================================================

-- Amounts and tax. A renewal price is NOT NULL by column definition, which is the point: the
-- shape this replaces let a joining price exist with no renewal price behind it, and that is how
-- the live data ended up unable to renew anybody.
ALTER TABLE "FeePlans" ADD CONSTRAINT "FeePlans_amount_non_negative"
  CHECK ("amount" >= 0);
ALTER TABLE "FeePlans" ADD CONSTRAINT "FeePlans_renewal_amount_non_negative"
  CHECK ("renewal_amount" >= 0);
ALTER TABLE "FeePlans" ADD CONSTRAINT "FeePlans_tax_rate_range"
  CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);
ALTER TABLE "FeePlans" ADD CONSTRAINT "FeePlans_effective_range_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- R-1: a cycle appears at most once per structure among its CURRENT rows. Superseded versions
-- are is_active = false, so a structure may hold several Yearly rows over time but only ever one
-- that is being offered.
CREATE UNIQUE INDEX "FeePlans_one_live_plan_per_cycle_per_structure"
  ON "FeePlans"("structure_id", "billing_cycle")
  WHERE ("is_active" AND "deletedAt" IS NULL);

-- R-2: one live price per cycle per day, across EVERY structure — not merely within one.
--
-- This is the constraint that makes decision D-3 true rather than merely intended: while
-- Membership 2026 is live for YEARLY, no other structure can publish a live YEARLY price
-- covering the same days, so a new price list cannot quietly appear alongside the current one and
-- leave the website showing two amounts for the same thing. The admin closes the old one first.
--
-- btree_gist (installed in M0) compares the enum directly. Casting it to text fails with
-- "functions in index expression must be marked IMMUTABLE", because an enum->text cast is only
-- STABLE — the same trap M2's original constraint documented.
ALTER TABLE "FeePlans"
  ADD CONSTRAINT "FeePlans_no_overlapping_live_price"
  EXCLUDE USING gist (
    "billing_cycle" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  )
  WHERE ("is_active" AND "deletedAt" IS NULL);

-- ============================================================================
-- Somewhere to record which plan was bought
--
-- All three are nullable and sit BESIDE the existing fee_structure_id columns rather than
-- replacing them, so anything already in flight keeps pricing exactly as it does today.
-- ============================================================================

-- The one that cannot wait. Nothing reads it until M6, but a term created without it carries no
-- record of which plan was bought, and every member approved in the meantime becomes unpriceable
-- when the renewal engine arrives. RESTRICT rather than SET NULL: losing this link would leave a
-- term with no renewal price at all, which is the failure the column exists to prevent.
ALTER TABLE "MembershipTerms" ADD COLUMN "fee_plan_id" BIGINT;

ALTER TABLE "MembershipTerms"
  ADD CONSTRAINT "MembershipTerms_fee_plan_id_fkey"
  FOREIGN KEY ("fee_plan_id") REFERENCES "FeePlans"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "MembershipTerms_fee_plan_id_idx" ON "MembershipTerms"("fee_plan_id");

-- The applicant's choice, carried from the membership page. SET NULL, as for fee_structure_id:
-- retiring a price must not delete an application.
ALTER TABLE "MembershipApplications" ADD COLUMN "fee_plan_id" BIGINT;

ALTER TABLE "MembershipApplications"
  ADD CONSTRAINT "MembershipApplications_fee_plan_id_fkey"
  FOREIGN KEY ("fee_plan_id") REFERENCES "FeePlans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MembershipApplications_fee_plan_id_idx"
  ON "MembershipApplications"("fee_plan_id");

-- What an invoice line was priced from, so a charge is always traceable to the plan behind it.
ALTER TABLE "InvoiceItems" ADD COLUMN "fee_plan_id" BIGINT;

ALTER TABLE "InvoiceItems"
  ADD CONSTRAINT "InvoiceItems_fee_plan_id_fkey"
  FOREIGN KEY ("fee_plan_id") REFERENCES "FeePlans"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "InvoiceItems_fee_plan_id_idx" ON "InvoiceItems"("fee_plan_id");

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "FeePlanStructures" IS 'One version of the association''s price list, and the container the admin screen lists. It holds a name and a status and nothing else: dates, tax and prices live on the plans, because a price change touches one cycle at a time. The row exists so the list shows one line per price list rather than four, which is the whole reason the previous screen was unreadable. Separate from `FeeStructures` on purpose. That table and its screen stay live until this one replaces them, and a shared table would have made the swap a big-bang.';
COMMENT ON COLUMN "FeePlanStructures"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "FeePlanStructures"."name" IS 'What staff call this price list, e.g. "Membership 2026". Shown only in the admin.';
COMMENT ON COLUMN "FeePlanStructures"."is_active" IS 'Whether the list is offered to new applicants. Retiring hides it from the website and refuses new applications; it does NOT stop it billing the members already on it, whose renewals still resolve from its plans (spec §7).';
COMMENT ON COLUMN "FeePlanStructures"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "FeePlanStructures"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "FeePlanStructures"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';
COMMENT ON TABLE "FeePlans" IS 'One billing cycle''s price, carrying BOTH what it costs to join and what it costs to renew. The two prices sit on one row deliberately. As two unrelated rows — which is what `FeeStructures.fee_type` made them — nothing forced the pair to exist, and the live database ended up with three joining prices and a single renewal price that was switched off. A member approved under that arrangement reaches renewal with no price to charge. A price that has been invoiced is never edited. It is closed and a new row takes its place, so last year''s invoice stays explainable; `price_scope` on the new row records whether the members on the old one come with it.';
COMMENT ON COLUMN "FeePlans"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "FeePlans"."structure_id" IS 'FK to FeePlanStructures.id. ON DELETE RESTRICT — a list holding priced history is not something a delete should be able to take with it.';
COMMENT ON COLUMN "FeePlans"."billing_cycle" IS 'Which of the four cycles this price is for.';
COMMENT ON COLUMN "FeePlans"."name" IS 'What a member sees on the website, e.g. "Best Value". Names the plan, not the cycle.';
COMMENT ON COLUMN "FeePlans"."amount" IS 'Joining price before tax, INR, 2 decimal places. Never a float (ADR-007). Charged once, when an application is approved. CHECK amount >= 0.';
COMMENT ON COLUMN "FeePlans"."renewal_amount" IS 'Renewal price before tax, charged every term after the first. Required, which is the constraint this whole redesign exists to impose. CHECK renewal_amount >= 0.';
COMMENT ON COLUMN "FeePlans"."tax_rate" IS 'Tax percentage applied on top of both prices, e.g. 18.00 for GST. CHECK between 0 and 100.';
COMMENT ON COLUMN "FeePlans"."currency" IS 'ISO-4217 currency code. INR only for now (assumption A-3).';
COMMENT ON COLUMN "FeePlans"."effective_from" IS 'First date this price applies, inclusive.';
COMMENT ON COLUMN "FeePlans"."effective_to" IS 'Last date this price applies, inclusive. NULL means open-ended. CHECK effective_to IS NULL OR effective_to > effective_from.';
COMMENT ON COLUMN "FeePlans"."price_scope" IS 'Whether members on an OLDER price move to this one at renewal. Written when the row is published and never inferred later.';
COMMENT ON COLUMN "FeePlans"."is_active" IS 'Whether this row is the one currently offered for its cycle. A false row is history: it no longer appears on the website, and it still prices the renewals of members sitting on it.';
COMMENT ON COLUMN "FeePlans"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "FeePlans"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "FeePlans"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';
COMMENT ON COLUMN "MembershipApplications"."fee_plan_id" IS 'FK to FeePlans.id — the plan picked on the redesigned membership page. Sits BESIDE `fee_structure_id` rather than replacing it: the old price list and its screen stay live until the new one takes over, and an application in flight must keep pricing from whichever of the two it was created against. Exactly one is set on any new row.';
COMMENT ON COLUMN "MembershipTerms"."fee_plan_id" IS 'FK to FeePlans.id — the plan this term was priced from. Nullable because terms created before fee plans existed carry no choice, and because staff entering one on an applicant''s behalf may still have none. Written at approval from the moment the column exists, even though nothing reads it until M6: a term created without it has no record of which plan was bought, and every such member becomes unpriceable when the renewal engine arrives. One column now, or a data-repair job later.';
COMMENT ON COLUMN "InvoiceItems"."fee_plan_id" IS 'FK to FeePlans.id — the plan this line was priced from, for lines raised under the redesigned price list. ON DELETE SET NULL, for the same reason as above: retiring a price must never orphan the invoices that quoted it.';
