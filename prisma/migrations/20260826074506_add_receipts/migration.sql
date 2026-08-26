-- CreateTable
CREATE TABLE "Receipts" (
    "id" BIGSERIAL NOT NULL,
    "receipt_number" VARCHAR(30) NOT NULL,
    "invoice_id" BIGINT NOT NULL,
    "member_id" BIGINT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pdf_path" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Receipts_receipt_number_key" ON "Receipts"("receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "Receipts_invoice_id_key" ON "Receipts"("invoice_id");

-- CreateIndex
CREATE INDEX "Receipts_member_id_paid_at_idx" ON "Receipts"("member_id", "paid_at" DESC);

-- AddForeignKey
ALTER TABLE "Receipts" ADD CONSTRAINT "Receipts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipts" ADD CONSTRAINT "Receipts_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
