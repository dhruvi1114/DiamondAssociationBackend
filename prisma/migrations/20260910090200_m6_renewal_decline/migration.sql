-- M6 — "Don't renew" (decided 2026-09-10). Stored on the term being left, so the hourly
-- renewal job can tell "not raised yet" from "the member said no".
ALTER TABLE "MembershipTerms" ADD COLUMN "renewal_declined_at" TIMESTAMPTZ(6);

COMMENT ON COLUMN "MembershipTerms"."renewal_declined_at" IS 'When the member said they will not renew after this term. The renewal job raises nothing for a term with this set; "renew after all" clears it. NULL means no decision was made.';
