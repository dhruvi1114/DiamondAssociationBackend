-- M7 — the two foreign keys those columns should always have had.
--
-- EventRegistrations.invoice_id and PaymentSubmissions.payment_id were created
-- without a relation declared, so Prisma emitted no constraint and the columns
-- could hold an id pointing at nothing. Both are additive; no data is touched.

BEGIN;

-- AddForeignKey
ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "Payments"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoices"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT;
