-- M6 — membership renewal.
-- Spec: docs/modules/M6-renewal.md · docs/renewal-module-summary.md (decisions 2026-09-10)
--
-- Two guards the renewal job relies on. Both are enforced by the database, not the code:
-- code can forget to check, a constraint cannot.

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE "RenewalReminders" (
  "id"            BIGSERIAL      PRIMARY KEY,
  "term_id"       BIGINT         NOT NULL,
  "reminder_code" VARCHAR(10)    NOT NULL,
  "sent_on"       DATE           NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RenewalReminders_term_id_fkey" FOREIGN KEY ("term_id")
    REFERENCES "MembershipTerms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RenewalReminders_code_known"
    CHECK ("reminder_code" IN ('T-15', 'T-7', 'T-3', 'T-0'))
);

-- One reminder per stage per term: a second job run inserts nothing and sends nothing.
CREATE UNIQUE INDEX "RenewalReminders_term_id_reminder_code_key"
  ON "RenewalReminders"("term_id", "reminder_code");

-- ============================================================================
-- Terms: one live term per member per start date
--
-- A renewal job that runs twice (restart, retry, the admin's "Generate Invoices") must not
-- bill a member twice. CANCELLED is excluded on purpose: switching plan before paying cancels
-- the renewal term and creates a new one with the SAME start date.
-- ============================================================================

CREATE UNIQUE INDEX "MembershipTerms_one_live_term_per_start"
  ON "MembershipTerms"("member_id", "valid_from") WHERE "status" <> 'CANCELLED';

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts RenewalReminders
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "RenewalReminders" IS 'One renewal reminder sent for one renewal term at one stage (T-15, T-7, T-3, T-0). Exists so a job that runs twice cannot send the same reminder twice: the unique (term_id, reminder_code) makes the second insert a no-op, and a message is queued only when the insert happened.';
COMMENT ON COLUMN "RenewalReminders"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "RenewalReminders"."term_id" IS 'FK to MembershipTerms.id — the unpaid renewal term the reminder is about. ON DELETE CASCADE.';
COMMENT ON COLUMN "RenewalReminders"."reminder_code" IS 'Stage: ''T-15'', ''T-7'', ''T-3'' or ''T-0'' (days before the current term ends). CHECK-constrained.';
COMMENT ON COLUMN "RenewalReminders"."sent_on" IS 'Calendar day the reminder was sent (server''s local day).';
COMMENT ON COLUMN "RenewalReminders"."createdAt" IS 'Row creation timestamp (UTC).';
