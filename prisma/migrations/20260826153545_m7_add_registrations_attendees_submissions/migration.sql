-- M7 — bookings, the people on them, and the payment claims staff verify.
--
-- Three new tables; nothing existing is touched. There is deliberately no
-- attendance table: this module records who is *going* to attend, not who turned
-- up on the day. That can be added later without changing anything here.
--
-- Wrapped in an explicit transaction: all of it applies, or none of it does.

BEGIN;

-- CreateTable
CREATE TABLE "PaymentSubmissions" (
    "id" BIGSERIAL NOT NULL,
    "invoice_id" BIGINT NOT NULL,
    "submitted_by_user_id" BIGINT,
    "submitted_by_guest_id" BIGINT,
    "method" SMALLINT NOT NULL,
    "reference_no" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "proof_path" TEXT,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "rejection_reason" TEXT,
    "verified_by_admin_id" BIGINT,
    "verified_at" TIMESTAMPTZ(6),
    "payment_id" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "PaymentSubmissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRegistrations" (
    "id" BIGSERIAL NOT NULL,
    "event_id" BIGINT NOT NULL,
    "registrant_type" SMALLINT NOT NULL,
    "member_id" BIGINT,
    "user_id" BIGINT,
    "guest_registrant_id" BIGINT,
    "registration_code" VARCHAR(30) NOT NULL,
    "status" SMALLINT NOT NULL,
    "attendee_count" INTEGER NOT NULL DEFAULT 1,
    "price_tier_id" BIGINT,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "invoice_id" BIGINT,
    "expires_at" TIMESTAMPTZ(6),
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_admin_id" BIGINT,
    "rejection_reason" TEXT,
    "terms_accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "terms_version" VARCHAR(20) NOT NULL,
    "media_consent" BOOLEAN NOT NULL DEFAULT false,
    "billing_company_name" VARCHAR(200),
    "gst_number" VARCHAR(20),
    "pan_number" VARCHAR(10),
    "iec_code" VARCHAR(20),
    "billing_line1" VARCHAR(200),
    "billing_line2" VARCHAR(200),
    "billing_city" VARCHAR(100),
    "billing_state" VARCHAR(100),
    "billing_pincode" VARCHAR(10),
    "billing_country" VARCHAR(100),
    "contact_name" VARCHAR(150),
    "contact_email" CITEXT,
    "contact_phone" VARCHAR(20),
    "cancelled_by" SMALLINT,
    "cancelled_at" TIMESTAMPTZ(6),
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "EventRegistrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRegistrationAttendees" (
    "id" BIGSERIAL NOT NULL,
    "registration_id" BIGINT NOT NULL,
    "member_user_id" BIGINT,
    "attendee_code" VARCHAR(30) NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "designation" VARCHAR(100),
    "email" CITEXT,
    "phone" VARCHAR(20),
    "unit_price" DECIMAL(14,2) NOT NULL,
    "food_preference" SMALLINT,
    "photo_path" TEXT,
    "id_type" SMALLINT,
    "id_number" VARCHAR(50),
    "special_requirement" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "EventRegistrationAttendees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentSubmissions_status_createdAt_idx" ON "PaymentSubmissions"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PaymentSubmissions_invoice_id_idx" ON "PaymentSubmissions"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "EventRegistrations_registration_code_key" ON "EventRegistrations"("registration_code");

-- CreateIndex
CREATE INDEX "EventRegistrations_event_id_status_idx" ON "EventRegistrations"("event_id", "status");

-- CreateIndex
CREATE INDEX "EventRegistrations_status_expires_at_idx" ON "EventRegistrations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "EventRegistrations_member_id_registered_at_idx" ON "EventRegistrations"("member_id", "registered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EventRegistrationAttendees_attendee_code_key" ON "EventRegistrationAttendees"("attendee_code");

-- CreateIndex
CREATE INDEX "EventRegistrationAttendees_registration_id_idx" ON "EventRegistrationAttendees"("registration_id");

-- CreateIndex
CREATE INDEX "EventRegistrationAttendees_email_idx" ON "EventRegistrationAttendees"("email");

-- AddForeignKey
ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoices"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Events"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistrationAttendees" ADD CONSTRAINT "EventRegistrationAttendees_registration_id_fkey" FOREIGN KEY ("registration_id") REFERENCES "EventRegistrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written half: guards Prisma cannot express, and comments (ADR-013).
-- ---------------------------------------------------------------------------

-- Exactly one payer. A booking belongs to a member or to a guest, never both and
-- never neither — the same either-or pattern as Invoices and AuthTokens.
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_member_or_guest"
  CHECK (
    ("registrant_type" = 0 AND "member_id" IS NOT NULL AND "guest_registrant_id" IS NULL)
    OR
    ("registrant_type" = 1 AND "guest_registrant_id" IS NOT NULL AND "member_id" IS NULL)
  );

-- A refusal without a reason is a support call. Mandatory, at the database.
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_rejection_has_reason"
  CHECK ("status" <> 6 OR "rejection_reason" IS NOT NULL);

-- Anything still waiting — for approval or for payment — must know when its
-- seats are released. A hold with no deadline is a seat frozen forever.
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_pending_has_deadline"
  CHECK ("status" NOT IN (0, 1) OR "expires_at" IS NOT NULL);

ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_status_range"
  CHECK ("status" IN (0, 1, 2, 3, 4, 5, 6, 7));
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_registrant_type_range"
  CHECK ("registrant_type" IN (0, 1));
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_cancelled_by_range"
  CHECK ("cancelled_by" IS NULL OR "cancelled_by" IN (0, 1, 2));
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_attendee_count_positive"
  CHECK ("attendee_count" > 0);
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_amounts_non_negative"
  CHECK ("subtotal" >= 0 AND "tax_amount" >= 0 AND "total_amount" >= 0);
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

-- One LIVE booking per company per event. Partial, so a company whose hold
-- expired or who cancelled can book again — a plain unique index would lock them
-- out of an event they never actually attended.
CREATE UNIQUE INDEX "EventRegistrations_one_live_per_member"
  ON "EventRegistrations" ("event_id", "member_id")
  WHERE "status" IN (0, 1, 2, 3) AND "deletedAt" IS NULL AND "member_id" IS NOT NULL;

ALTER TABLE "EventRegistrationAttendees" ADD CONSTRAINT "EventRegistrationAttendees_price_non_negative"
  CHECK ("unit_price" >= 0);
ALTER TABLE "EventRegistrationAttendees" ADD CONSTRAINT "EventRegistrationAttendees_food_range"
  CHECK ("food_preference" IS NULL OR "food_preference" IN (0, 1, 2));
ALTER TABLE "EventRegistrationAttendees" ADD CONSTRAINT "EventRegistrationAttendees_id_type_range"
  CHECK ("id_type" IS NULL OR "id_type" IN (0, 1, 2, 3, 4));
ALTER TABLE "EventRegistrationAttendees" ADD CONSTRAINT "EventRegistrationAttendees_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "EventRegistrationAttendees" ADD CONSTRAINT "EventRegistrationAttendees_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_amount_positive"
  CHECK ("amount" > 0);
ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_status_range"
  CHECK ("status" IN (0, 1, 2));
ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_method_range"
  CHECK ("method" IN (0, 1, 2, 3));
ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_rejection_has_reason"
  CHECK ("status" <> 2 OR "rejection_reason" IS NOT NULL);
ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "PaymentSubmissions" ADD CONSTRAINT "PaymentSubmissions_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

-- One claim in flight per invoice. Two pending claims would put the same invoice
-- in the verification queue twice and let it be banked twice.
CREATE UNIQUE INDEX "PaymentSubmissions_one_pending_per_invoice"
  ON "PaymentSubmissions" ("invoice_id")
  WHERE "status" = 0;

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "PaymentSubmissions" IS 'A claim that money was sent, awaiting staff verification. This is the step that stands in for a payment gateway: the payer transfers by NEFT or UPI, says so with a reference and a receipt, and an admin confirms it landed. Deliberately generic on `Invoices` rather than on a registration, so membership invoices reuse the same queue. Distinct from `Payments`: a submission is what the payer *claims*, a payment is what the association *confirms*. Collapsing the two would mean an unverified claim already looked like money received.';
COMMENT ON COLUMN "PaymentSubmissions"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "PaymentSubmissions"."invoice_id" IS 'FK to Invoices.id. ON DELETE NO ACTION — a financial record is never orphaned.';
COMMENT ON COLUMN "PaymentSubmissions"."submitted_by_user_id" IS 'The member login that submitted it. NULL when a guest did.';
COMMENT ON COLUMN "PaymentSubmissions"."submitted_by_guest_id" IS 'The guest who submitted it. NULL when a member did.';
COMMENT ON COLUMN "PaymentSubmissions"."method" IS '0 = NEFT, 1 = UPI, 2 = CHEQUE, 3 = CASH.';
COMMENT ON COLUMN "PaymentSubmissions"."reference_no" IS 'UTR, cheque number or the reference the payer was given.';
COMMENT ON COLUMN "PaymentSubmissions"."amount" IS 'What they say they sent, INR, 2dp. CHECK amount > 0.';
COMMENT ON COLUMN "PaymentSubmissions"."paid_on" IS 'The date on the transfer, as the payer states it.';
COMMENT ON COLUMN "PaymentSubmissions"."proof_path" IS 'Storage key of the uploaded receipt, through @helpers/storage.';
COMMENT ON COLUMN "PaymentSubmissions"."status" IS '0 = PENDING, 1 = VERIFIED, 2 = REJECTED.';
COMMENT ON COLUMN "PaymentSubmissions"."rejection_reason" IS 'Why it was refused. Mandatory when REJECTED — "UTR not found in our statement" tells the payer what to do next; a bare rejection does not.';
COMMENT ON COLUMN "PaymentSubmissions"."verified_by_admin_id" IS 'Which staff account decided.';
COMMENT ON COLUMN "PaymentSubmissions"."verified_at" IS 'When they decided.';
COMMENT ON COLUMN "PaymentSubmissions"."payment_id" IS 'The Payments row created on verification. NULL until then.';
COMMENT ON COLUMN "PaymentSubmissions"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "PaymentSubmissions"."created_by_user_id" IS 'Member login that created this row.';
COMMENT ON COLUMN "PaymentSubmissions"."created_by_admin_id" IS 'Staff account that created this row.';
COMMENT ON COLUMN "PaymentSubmissions"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "PaymentSubmissions"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "PaymentSubmissions"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMENT ON TABLE "EventRegistrations" IS 'One booking: a company (or a guest) taking seats at an event. The people are on `EventRegistrationAttendees` — this row is the booking, the money and the state. There is no attendance table: this module records who is *going* to attend, not who turned up on the day, which is deliberately out of scope and can be added later without touching anything here.';
COMMENT ON COLUMN "EventRegistrations"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "EventRegistrations"."event_id" IS 'FK to Events.id. ON DELETE NO ACTION — an event with bookings is cancelled, never deleted out from under them.';
COMMENT ON COLUMN "EventRegistrations"."registrant_type" IS '0 = MEMBER, 1 = GUEST.';
COMMENT ON COLUMN "EventRegistrations"."member_id" IS 'FK to Members.id when a member booked. Exactly one of this and `guest_registrant_id` is set, enforced by a CHECK.';
COMMENT ON COLUMN "EventRegistrations"."user_id" IS 'The login that pressed the button, for the audit trail. NULL for a guest.';
COMMENT ON COLUMN "EventRegistrations"."guest_registrant_id" IS 'FK to GuestRegistrants.id when a non-member booked.';
COMMENT ON COLUMN "EventRegistrations"."registration_code" IS 'The booking''s own reference, quoted in emails and to the office.';
COMMENT ON COLUMN "EventRegistrations"."status" IS '0 PENDING_APPROVAL · 1 PENDING_PAYMENT · 2 PAYMENT_UNDER_VERIFICATION 3 CONFIRMED · 4 EXPIRED · 5 CANCELLED · 6 REJECTED · 7 REFUNDED';
COMMENT ON COLUMN "EventRegistrations"."attendee_count" IS 'How many seats this booking holds. Kept in step with the attendee rows.';
COMMENT ON COLUMN "EventRegistrations"."price_tier_id" IS 'The tier in force when the booking was made. The price is frozen per attendee; this records which window produced it.';
COMMENT ON COLUMN "EventRegistrations"."subtotal" IS 'Sum of the frozen attendee prices, INR, 2dp.';
COMMENT ON COLUMN "EventRegistrations"."tax_amount" IS 'Tax on the subtotal at the event''s rate.';
COMMENT ON COLUMN "EventRegistrations"."total_amount" IS 'What is owed.';
COMMENT ON COLUMN "EventRegistrations"."invoice_id" IS 'The invoice raised for it. NULL for a free event, and until approval on an event that requires it — which is the point: rejecting costs nothing to reverse because no invoice ever existed.';
COMMENT ON COLUMN "EventRegistrations"."expires_at" IS 'When the held seats are released if nobody pays. Set from `event.payment_hold_days`, and re-set at approval so an admin''s delay never eats the payer''s window.';
COMMENT ON COLUMN "EventRegistrations"."approved_at" IS 'When staff approved it, on an event that requires approval.';
COMMENT ON COLUMN "EventRegistrations"."approved_by_admin_id" IS 'Which staff account approved it.';
COMMENT ON COLUMN "EventRegistrations"."rejection_reason" IS 'Why it was refused. Mandatory when status is REJECTED.';
COMMENT ON COLUMN "EventRegistrations"."terms_accepted_at" IS 'When the booker accepted the terms. Stored, not inferred: this is what the association quotes back in a refund dispute.';
COMMENT ON COLUMN "EventRegistrations"."terms_version" IS 'Which version of the terms they accepted.';
COMMENT ON COLUMN "EventRegistrations"."media_consent" IS 'Whether they consented to event photography.';
COMMENT ON COLUMN "EventRegistrations"."billing_company_name" IS 'Billing snapshot, frozen at booking so a later profile edit cannot rewrite what an old invoice said.';
COMMENT ON COLUMN "EventRegistrations"."gst_number" IS 'GSTIN as it was at booking.';
COMMENT ON COLUMN "EventRegistrations"."pan_number" IS 'PAN as it was at booking.';
COMMENT ON COLUMN "EventRegistrations"."iec_code" IS 'IEC code as it was at booking.';
COMMENT ON COLUMN "EventRegistrations"."billing_line1" IS 'Billing address line 1, frozen.';
COMMENT ON COLUMN "EventRegistrations"."billing_line2" IS 'Billing address line 2, frozen.';
COMMENT ON COLUMN "EventRegistrations"."billing_city" IS 'Billing city, frozen.';
COMMENT ON COLUMN "EventRegistrations"."billing_state" IS 'Billing state, frozen.';
COMMENT ON COLUMN "EventRegistrations"."billing_pincode" IS 'Billing pincode, frozen.';
COMMENT ON COLUMN "EventRegistrations"."billing_country" IS 'Billing country, frozen.';
COMMENT ON COLUMN "EventRegistrations"."contact_name" IS 'Who to contact about this booking.';
COMMENT ON COLUMN "EventRegistrations"."contact_email" IS 'Where correspondence about this booking goes.';
COMMENT ON COLUMN "EventRegistrations"."contact_phone" IS 'Day-of contact number for the booking.';
COMMENT ON COLUMN "EventRegistrations"."cancelled_by" IS '0 = MEMBER, 1 = ADMIN, 2 = SYSTEM. Who ended it, when it was ended.';
COMMENT ON COLUMN "EventRegistrations"."cancelled_at" IS 'When it was cancelled or expired.';
COMMENT ON COLUMN "EventRegistrations"."registered_at" IS 'When the booking was made. The date that decides the price tier.';
COMMENT ON COLUMN "EventRegistrations"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "EventRegistrations"."created_by_user_id" IS 'Member login that created this row.';
COMMENT ON COLUMN "EventRegistrations"."created_by_admin_id" IS 'Staff account that created this row, when staff booked on someone''s behalf.';
COMMENT ON COLUMN "EventRegistrations"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "EventRegistrations"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "EventRegistrations"."updated_by_admin_id" IS 'Staff account that last changed this row.';
COMMENT ON COLUMN "EventRegistrations"."deletedAt" IS 'Soft-delete timestamp (UTC).';

COMMENT ON TABLE "EventRegistrationAttendees" IS 'One person on a booking — the answer to "who is going to attend". A row per delegate rather than a count, so the attendee report lists people rather than "ABC Pvt Ltd — 3", and so each person can be emailed their own code. Name, designation and price are snapshots: an attendee report from last year still shows what was true then.';
COMMENT ON COLUMN "EventRegistrationAttendees"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "EventRegistrationAttendees"."registration_id" IS 'FK to EventRegistrations.id. ON DELETE CASCADE — owned by the booking.';
COMMENT ON COLUMN "EventRegistrationAttendees"."member_user_id" IS 'FK to MemberUsers.id — which team login this delegate is. NULL for a guest, and SET NULL if the team row is ever removed: the booking still names them.';
COMMENT ON COLUMN "EventRegistrationAttendees"."attendee_code" IS 'This person''s own code, the one in their confirmation email.';
COMMENT ON COLUMN "EventRegistrationAttendees"."full_name" IS 'Name as it should appear on the badge and the entry list.';
COMMENT ON COLUMN "EventRegistrationAttendees"."designation" IS 'Job title, snapshot.';
COMMENT ON COLUMN "EventRegistrationAttendees"."email" IS 'Where this person''s own confirmation goes.';
COMMENT ON COLUMN "EventRegistrationAttendees"."phone" IS 'Day-of contact number.';
COMMENT ON COLUMN "EventRegistrationAttendees"."unit_price" IS 'The price frozen for this person, INR, 2dp. Frozen at booking, which is why paying three weeks later never changes what is owed.';
COMMENT ON COLUMN "EventRegistrationAttendees"."food_preference" IS '0 = VEG, 1 = NON_VEG, 2 = JAIN. Collected only when the event asks.';
COMMENT ON COLUMN "EventRegistrationAttendees"."photo_path" IS 'Storage key of the badge photo, when the event asks for one.';
COMMENT ON COLUMN "EventRegistrationAttendees"."id_type" IS '0 AADHAAR · 1 PAN · 2 PASSPORT · 3 DL · 4 VOTER.';
COMMENT ON COLUMN "EventRegistrationAttendees"."id_number" IS 'The ID number, when the venue requires one.';
COMMENT ON COLUMN "EventRegistrationAttendees"."special_requirement" IS 'Wheelchair access, dietary need, interpreter — anything the venue must know.';
COMMENT ON COLUMN "EventRegistrationAttendees"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "EventRegistrationAttendees"."created_by_user_id" IS 'Member login that created this row.';
COMMENT ON COLUMN "EventRegistrationAttendees"."created_by_admin_id" IS 'Staff account that created this row.';
COMMENT ON COLUMN "EventRegistrationAttendees"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "EventRegistrationAttendees"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "EventRegistrationAttendees"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMIT;
