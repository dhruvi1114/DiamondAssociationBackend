-- Repair the comment debt on "Receipts".
--
-- ADR-013 requires a COMMENT ON for every table and column; the migration that
-- created Receipts omitted them. Normally comments belong in the migration that
-- creates the object, and this is not an exception being taken lightly — it is a
-- fix-forward for an object that already exists, which is the only route left
-- once a migration is applied.
--
-- It is done here rather than left alone because the coverage query flags every
-- column of a table whose own comment is missing. Without the table comment,
-- the payment_id column added in the previous migration is reported as
-- undocumented even though it is documented.
--
-- No data is touched; comments are metadata only.

BEGIN;

COMMENT ON TABLE "Receipts" IS 'The document handed to a payer acknowledging one payment. Distinct from Payments, which is the money event itself.';
COMMENT ON COLUMN "Receipts"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Receipts"."receipt_number" IS 'Human-facing number, RC + year + calendar quarter + 3-digit sequence restarting each quarter, e.g. RC202603001.';
COMMENT ON COLUMN "Receipts"."invoice_id" IS 'FK to Invoices.id — the invoice this receipt closes out. ON DELETE RESTRICT: a receipt is a financial record and is never orphaned. One receipt per invoice.';
COMMENT ON COLUMN "Receipts"."member_id" IS 'FK to Members.id — who paid. Denormalised off the invoice so a receipt still names the payer even if the invoice link were ever changed.';
COMMENT ON COLUMN "Receipts"."amount" IS 'Amount received, INR, 2dp. Always the invoice total today — this build has no partial payments.';
COMMENT ON COLUMN "Receipts"."paid_at" IS 'When the payment was recorded.';
COMMENT ON COLUMN "Receipts"."pdf_path" IS 'Storage key of the rendered PDF, through @helpers/storage — the same adapter as KYC documents and invoice PDFs.';
COMMENT ON COLUMN "Receipts"."createdAt" IS 'Row creation timestamp (UTC).';

COMMIT;
