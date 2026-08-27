-- M7 — Event Types, the master behind the event form's "Event Type" field.
--
-- A master rather than a code enum (client decision, 2026-08-27): the list of
-- event kinds belongs to the association, and one that can only be changed by a
-- release is one that quietly becomes free text.
--
-- `Events.event_type_id` is NULLABLE. Every event created before today has no
-- type, and backfilling one would be inventing a fact about somebody else's
-- event. The form offers the field; it does not demand it.
--
-- The foreign key is NO ACTION, not SET NULL or CASCADE: a type in use must not
-- be removable out from under the events carrying it. The master deactivates
-- instead, and the delete path refuses with a count of what is still using it.
--
-- Seeded with a starter list the association is expected to edit — it owns this
-- table now. Seeded by INSERT … ON CONFLICT DO NOTHING so re-running is safe and
-- so a row the association has since renamed is never overwritten.

BEGIN;

-- AlterTable
ALTER TABLE "Events" ADD COLUMN     "event_type_id" BIGINT;

-- CreateTable
CREATE TABLE "EventTypes" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_admin_id" BIGINT,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "EventTypes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventTypes_code_key" ON "EventTypes"("code");

-- CreateIndex
CREATE INDEX "EventTypes_is_active_display_order_idx" ON "EventTypes"("is_active", "display_order");

-- CreateIndex
CREATE INDEX "Events_event_type_id_idx" ON "Events"("event_type_id");

-- AddForeignKey
ALTER TABLE "Events" ADD CONSTRAINT "Events_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "EventTypes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "EventTypes" IS 'What kind of event this is — Conference, Seminar, Exhibition, Buyer-Seller Meet. A master the association maintains itself rather than a code enum, because the list is theirs: a trade body adds "Buyer-Seller Meet" the week it decides to run one, and waiting on a release to do it is the reason such fields end up as free text and stop being countable. Deactivated rather than deleted once used. An event already tagged with a type keeps it — the type is part of what that event WAS — so `is_active` says only whether the form may still offer it.';
COMMENT ON COLUMN "EventTypes"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "EventTypes"."code" IS 'Stable machine name, e.g. CONFERENCE. Immutable once created.';
COMMENT ON COLUMN "EventTypes"."name" IS 'Display name shown on the event form and beside the event, e.g. "Conference".';
COMMENT ON COLUMN "EventTypes"."display_order" IS 'Sort position on the form. Lower first.';
COMMENT ON COLUMN "EventTypes"."is_active" IS 'Whether the event form may still offer it. Existing events keep theirs regardless.';
COMMENT ON COLUMN "EventTypes"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "EventTypes"."created_by_admin_id" IS 'Staff account that created this row.';
COMMENT ON COLUMN "EventTypes"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "EventTypes"."updated_by_admin_id" IS 'Staff account that last changed this row.';
COMMENT ON COLUMN "EventTypes"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means live; all reads filter on it.';
COMMENT ON COLUMN "Events"."event_type_id" IS 'What kind of event this is, from the `EventTypes` master. Optional: events created before the master existed have none, and an association that does not classify its events should not be forced to.';

-- ============================================================================
-- Starter list. Editable by staff from Masters ▸ Event Types the moment this
-- lands; `ON CONFLICT DO NOTHING` keeps a re-run from undoing their edits.
-- ============================================================================

INSERT INTO "EventTypes" ("code", "name", "display_order", "updatedAt") VALUES
  ('CONFERENCE',   'Conference',        1, now()),
  ('SEMINAR',      'Seminar',           2, now()),
  ('WORKSHOP',     'Workshop',          3, now()),
  ('EXHIBITION',   'Exhibition',        4, now()),
  ('TRADE_FAIR',   'Trade Fair',        5, now()),
  ('BUYER_SELLER', 'Buyer-Seller Meet', 6, now()),
  ('AGM',          'AGM',               7, now()),
  ('TRAINING',     'Training',          8, now()),
  ('NETWORKING',   'Networking',        9, now())
ON CONFLICT ("code") DO NOTHING;

COMMIT;
