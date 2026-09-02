-- CreateTable
CREATE TABLE "GeneratedReports" (
    "id" BIGSERIAL NOT NULL,
    "report_type" VARCHAR(40) NOT NULL,
    "report_name" VARCHAR(200) NOT NULL,
    "from_date" DATE,
    "to_date" DATE,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "include_details" BOOLEAN NOT NULL DEFAULT false,
    "report_data" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(20) NOT NULL DEFAULT 'ready',
    "row_count" BIGINT NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "generated_by" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedReports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeneratedReports_report_type_createdAt_idx" ON "GeneratedReports"("report_type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GeneratedReports_generated_by_createdAt_idx" ON "GeneratedReports"("generated_by", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GeneratedReports_createdAt_idx" ON "GeneratedReports"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "GeneratedReports" ADD CONSTRAINT "GeneratedReports_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "AdminUsers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The four reports this platform has. A CHECK rather than an enum, so adding a fifth is one
-- migration against one table. Without it a typo'd report_type sits in the table and produces
-- a download with no columns, which reads as "the report found nothing".
ALTER TABLE "GeneratedReports" ADD CONSTRAINT "GeneratedReports_report_type_check"
  CHECK ("report_type" IN ('members', 'revenue', 'renewals', 'events'));

-- 'queued' and 'running' are unreachable today: generation is inline, so a row is written
-- 'ready' or not at all. They are in the constraint from the start because adding a value to
-- a CHECK later is a second migration against the same table, and background generation is a
-- decided future rather than a hypothetical one.
ALTER TABLE "GeneratedReports" ADD CONSTRAINT "GeneratedReports_status_check"
  CHECK ("status" IN ('queued', 'running', 'ready', 'failed'));

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "GeneratedReports" IS 'One report that somebody ran. The result is stored rather than recomputed: a report is a historical record, and the whole point of saving it is that it still says the same thing next month, after a category has been renamed or a company terminated.';
COMMENT ON COLUMN "GeneratedReports"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "GeneratedReports"."report_type" IS 'Which of the four reports this is: members, revenue, renewals or events. Constrained by a CHECK rather than an enum, so adding a fifth is a migration against one table.';
COMMENT ON COLUMN "GeneratedReports"."report_name" IS 'What the person called it. Suggested from the filters, editable before generating.';
COMMENT ON COLUMN "GeneratedReports"."from_date" IS 'Lower bound of the report''s date range, or NULL where the report takes none.';
COMMENT ON COLUMN "GeneratedReports"."to_date" IS 'Upper bound, an inclusive whole day.';
COMMENT ON COLUMN "GeneratedReports"."filters" IS 'The filters that produced this result, as {id, name} pairs keyed by filter. Names are stored beside ids deliberately: an id-only filter becomes unreadable the moment a category or a company is renamed, and the saved numbers stop being explainable.';
COMMENT ON COLUMN "GeneratedReports"."include_details" IS 'Whether the row-level breakdown was collected. Decides whether the download carries a Detail sheet.';
COMMENT ON COLUMN "GeneratedReports"."report_data" IS 'The frozen result: { summary: {...}, detail: [...] or null, row_count: n }.';
COMMENT ON COLUMN "GeneratedReports"."status" IS 'queued, running, ready or failed. Only ready and failed are written today; the other two are in the CHECK from the start because adding a value to a constraint later is a second migration against the same table, and background generation is a decided future.';
COMMENT ON COLUMN "GeneratedReports"."row_count" IS 'How many detail rows matched, whether or not they were stored. Kept even for a report generated without detail, so a later run is a decision made with the size in hand.';
COMMENT ON COLUMN "GeneratedReports"."error_message" IS 'Why it failed, for a failed row. NULL otherwise.';
COMMENT ON COLUMN "GeneratedReports"."generated_by" IS 'AdminUsers.id. ON DELETE RESTRICT: a report must never lose the person who ran it.';
COMMENT ON COLUMN "GeneratedReports"."createdAt" IS 'Row creation timestamp (UTC) -- when the report was run.';
