-- A fifth report: one member's statement.
--
-- The report_type CHECK is widened rather than dropped. Keeping the constraint
-- is the point of having it: a typo'd report_type would otherwise sit in the
-- table and produce a download with no columns, which reads to whoever opens it
-- as "the report found nothing".
--
-- Recreated rather than altered because Postgres has no ALTER CONSTRAINT for a
-- CHECK expression; drop-and-add inside the migration's transaction is the
-- supported form, and no row can be written between the two statements.
ALTER TABLE "GeneratedReports" DROP CONSTRAINT "GeneratedReports_report_type_check";

ALTER TABLE "GeneratedReports" ADD CONSTRAINT "GeneratedReports_report_type_check"
  CHECK ("report_type" IN ('members', 'revenue', 'renewals', 'events', 'statement'));
