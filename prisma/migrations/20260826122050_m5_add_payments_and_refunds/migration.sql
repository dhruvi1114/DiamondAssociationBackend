-- M5 completion — Payments and Refunds.
--
-- Purely additive: two new tables and one new nullable column on Receipts.
-- No existing column is dropped, renamed or retyped, so every current read path
-- keeps working unchanged.
--
-- Wrapped in an explicit transaction: all of it applies, or none of it does.

BEGIN;

-- AlterTable
ALTER TABLE "Receipts" ADD COLUMN     "payment_id" BIGINT;

-- CreateTable
CREATE TABLE "Payments" (
    "id" BIGSERIAL NOT NULL,
    "payment_number" VARCHAR(30) NOT NULL,
    "invoice_id" BIGINT NOT NULL,
    "member_id" BIGINT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "method" SMALLINT NOT NULL,
    "provider" VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
    "provider_order_id" VARCHAR(100),
    "provider_payment_id" VARCHAR(100),
    "status" SMALLINT NOT NULL,
    "paid_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "recorded_by_admin_id" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "Payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refunds" (
    "id" BIGSERIAL NOT NULL,
    "refund_number" VARCHAR(30) NOT NULL,
    "payment_id" BIGINT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "provider_refund_id" VARCHAR(100),
    "requested_by_admin_id" BIGINT,
    "approved_by_admin_id" BIGINT,
    "processed_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "Refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payments_payment_number_key" ON "Payments"("payment_number");

-- CreateIndex
CREATE INDEX "Payments_invoice_id_idx" ON "Payments"("invoice_id");

-- CreateIndex
CREATE INDEX "Payments_member_id_paid_at_idx" ON "Payments"("member_id", "paid_at" DESC);

-- CreateIndex
CREATE INDEX "Payments_status_createdAt_idx" ON "Payments"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Refunds_refund_number_key" ON "Refunds"("refund_number");

-- CreateIndex
CREATE INDEX "Refunds_payment_id_idx" ON "Refunds"("payment_id");

-- CreateIndex
CREATE INDEX "Refunds_status_createdAt_idx" ON "Refunds"("status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Receipts_payment_id_key" ON "Receipts"("payment_id");

-- AddForeignKey
ALTER TABLE "Receipts" ADD CONSTRAINT "Receipts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payments"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoices"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refunds" ADD CONSTRAINT "Refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payments"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written half: guards Prisma cannot express, the backfill, and comments.
-- ---------------------------------------------------------------------------

-- Money must be money.
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "Refunds" ADD CONSTRAINT "Refunds_amount_positive"
  CHECK ("amount" > 0);

-- Integer enum codes are only meaningful in range.
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_method_range"
  CHECK ("method" IN (0, 1, 2, 3, 4, 5));
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_status_range"
  CHECK ("status" IN (0, 1, 2, 3, 4, 5, 6));
ALTER TABLE "Refunds" ADD CONSTRAINT "Refunds_status_range"
  CHECK ("status" IN (0, 1, 2, 3, 4));

-- A successful payment must say when the money landed; an unsuccessful one
-- must not claim it did.
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_paid_at_matches_status"
  CHECK (("status" = 2) = ("paid_at" IS NOT NULL));

-- At most one actor per audit event. Both NULL means the system did it.
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "Payments" ADD CONSTRAINT "Payments_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));
ALTER TABLE "Refunds" ADD CONSTRAINT "Refunds_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "Refunds" ADD CONSTRAINT "Refunds_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

-- Gateway ids are the idempotency guard against a replayed webhook (R-7).
-- Partial, because NULL is the normal state for an offline payment and NULLs
-- must not collide with each other.
CREATE UNIQUE INDEX "Payments_provider_order_id_key"
  ON "Payments" ("provider_order_id") WHERE "provider_order_id" IS NOT NULL;
CREATE UNIQUE INDEX "Payments_provider_payment_id_key"
  ON "Payments" ("provider_payment_id") WHERE "provider_payment_id" IS NOT NULL;
CREATE UNIQUE INDEX "Refunds_provider_refund_id_key"
  ON "Refunds" ("provider_refund_id") WHERE "provider_refund_id" IS NOT NULL;

-- Backfill: every receipt that already exists gets the payment it was always
-- implicitly acknowledging. Without this a receipt would sit with no payment
-- behind it and the new link would be a lie from the first row.
-- Method 1 = NEFT, status 2 = SUCCESS, provider MANUAL: these receipts were all
-- recorded by staff against an offline payment, which is the only path that
-- existed before now.
WITH inserted AS (
  INSERT INTO "Payments" (
    "payment_number", "invoice_id", "member_id", "amount", "currency",
    "method", "provider", "status", "paid_at", "createdAt", "updatedAt"
  )
  SELECT 'PY' || to_char(r."paid_at", 'YYYY') || 'BF'
           || lpad((row_number() OVER (ORDER BY r."id"))::text, 3, '0'),
         r."invoice_id", r."member_id", r."amount", 'INR',
         1, 'MANUAL', 2, r."paid_at", now(), now()
  FROM "Receipts" r
  WHERE r."payment_id" IS NULL
  RETURNING "id", "invoice_id"
)
UPDATE "Receipts" r
   SET "payment_id" = i."id"
  FROM inserted i
 WHERE r."invoice_id" = i."invoice_id"
   AND r."payment_id" IS NULL;

COMMENT ON TABLE "Payments" IS 'Money actually received against an invoice. Distinct from Receipts: a receipt is the document handed to the payer, a payment is the event itself, and it is what a refund points at.';
COMMENT ON COLUMN "Payments"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Payments"."payment_number" IS 'Human-facing number, PY + year + calendar quarter + 3-digit sequence restarting each quarter.';
COMMENT ON COLUMN "Payments"."invoice_id" IS 'FK to Invoices.id. ON DELETE NO ACTION — a financial record is never orphaned.';
COMMENT ON COLUMN "Payments"."member_id" IS 'FK to Members.id — who paid. Nullable so a non-member can pay for an event.';
COMMENT ON COLUMN "Payments"."amount" IS 'Amount received, INR, 2dp. CHECK amount > 0.';
COMMENT ON COLUMN "Payments"."currency" IS 'ISO-4217 currency. INR only for now (A-3).';
COMMENT ON COLUMN "Payments"."method" IS '0 = ONLINE, 1 = NEFT, 2 = CHEQUE, 3 = CASH, 4 = UPI, 5 = ADJUSTMENT.';
COMMENT ON COLUMN "Payments"."provider" IS 'MANUAL for an offline payment recorded by staff, otherwise the gateway code.';
COMMENT ON COLUMN "Payments"."provider_order_id" IS 'Gateway order id. Unique where present, so one order cannot be banked twice.';
COMMENT ON COLUMN "Payments"."provider_payment_id" IS 'Gateway payment id. Unique where present — the idempotency guard against webhook replay (R-7).';
COMMENT ON COLUMN "Payments"."status" IS '0 = INITIATED, 1 = PENDING, 2 = SUCCESS, 3 = FAILED, 4 = CANCELLED, 5 = REFUNDED, 6 = PARTIALLY_REFUNDED.';
COMMENT ON COLUMN "Payments"."paid_at" IS 'When the money landed. NULL until it does; required exactly when status is SUCCESS.';
COMMENT ON COLUMN "Payments"."failure_reason" IS 'Why a gateway declined, verbatim, so support can quote it back.';
COMMENT ON COLUMN "Payments"."recorded_by_admin_id" IS 'Staff account that recorded an offline payment. NULL for self-service.';
COMMENT ON COLUMN "Payments"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Payments"."created_by_user_id" IS 'Member login that created this row, when a member did.';
COMMENT ON COLUMN "Payments"."created_by_admin_id" IS 'Staff account that created this row, when staff did.';
COMMENT ON COLUMN "Payments"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Payments"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "Payments"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMENT ON TABLE "Refunds" IS 'Money returned out of a payment. A separate row rather than a negative amount, so the payment stays a faithful record of what was received and the refund carries its own approval trail.';
COMMENT ON COLUMN "Refunds"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Refunds"."refund_number" IS 'Human-facing number, RF + year + calendar quarter + 3-digit sequence.';
COMMENT ON COLUMN "Refunds"."payment_id" IS 'FK to Payments.id. ON DELETE NO ACTION — never orphaned.';
COMMENT ON COLUMN "Refunds"."amount" IS 'Amount returned, INR, 2dp. CHECK amount > 0. May be less than the payment.';
COMMENT ON COLUMN "Refunds"."reason" IS 'Why, in the association''s words. Shown to the payer and quoted in disputes.';
COMMENT ON COLUMN "Refunds"."status" IS '0 = REQUESTED, 1 = PROCESSING, 2 = COMPLETED, 3 = FAILED, 4 = REJECTED.';
COMMENT ON COLUMN "Refunds"."provider_refund_id" IS 'Gateway refund id. Unique where present, so one refund cannot be sent twice.';
COMMENT ON COLUMN "Refunds"."requested_by_admin_id" IS 'Staff account that raised it.';
COMMENT ON COLUMN "Refunds"."approved_by_admin_id" IS 'Staff account that approved it. NULL while still REQUESTED.';
COMMENT ON COLUMN "Refunds"."processed_at" IS 'When the money actually went back.';
COMMENT ON COLUMN "Refunds"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Refunds"."created_by_user_id" IS 'Member login that created this row. Always NULL today; refunds are staff-raised.';
COMMENT ON COLUMN "Refunds"."created_by_admin_id" IS 'Staff account that created this row.';
COMMENT ON COLUMN "Refunds"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Refunds"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "Refunds"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMENT ON COLUMN "Receipts"."payment_id" IS 'FK to Payments.id — the payment this document acknowledges. Nullable only because receipts predate the Payments table; every new receipt has one.';

COMMIT;
