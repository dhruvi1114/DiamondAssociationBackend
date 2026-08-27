-- Widen the paid_at rule so a refunded payment may keep its date.
--
-- The original CHECK read `(status = SUCCESS) = (paid_at IS NOT NULL)`, which is
-- right about one half — a payment that never succeeded must not claim money
-- arrived — and wrong about the other. A REFUNDED payment DID arrive; the money
-- was received and later sent back. Clearing paid_at to satisfy the constraint
-- would erase when it landed, which is exactly the fact a refund dispute turns on.
--
-- So the rule becomes: paid_at is set for every status that means the money
-- arrived (SUCCESS, REFUNDED, PARTIALLY_REFUNDED) and absent for every status
-- that means it did not.
--
-- Found by the constraint itself, when cancelling an event tried to mark a paid
-- registration's payment refunded and was refused.

BEGIN;

ALTER TABLE "Payments" DROP CONSTRAINT "Payments_paid_at_matches_status";

ALTER TABLE "Payments" ADD CONSTRAINT "Payments_paid_at_matches_status"
  CHECK (("status" IN (2, 5, 6)) = ("paid_at" IS NOT NULL));

COMMENT ON COLUMN "Payments"."paid_at" IS 'When the money landed. Required for SUCCESS, REFUNDED and PARTIALLY_REFUNDED — all of which mean it did arrive — and absent otherwise.';

COMMIT;
