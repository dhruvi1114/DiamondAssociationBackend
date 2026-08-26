-- M7 — Events and their price tiers.
--
-- Two brand-new tables; nothing existing is touched. Price lives in
-- EventPriceTiers rather than a fee column on Events, because what a delegate
-- pays depends on the booking date and on whether they are a member.
--
-- Wrapped in an explicit transaction: all of it applies, or none of it does.

BEGIN;

-- CreateTable
CREATE TABLE "Events" (
    "id" BIGSERIAL NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "banner_path" TEXT,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "venue_name" VARCHAR(200),
    "venue_address_line1" VARCHAR(200),
    "venue_address_line2" VARCHAR(200),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "pincode" VARCHAR(10),
    "country" VARCHAR(100) NOT NULL DEFAULT 'India',
    "map_url" TEXT,
    "visibility" SMALLINT NOT NULL DEFAULT 0,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "capacity" INTEGER,
    "seats_taken" INTEGER NOT NULL DEFAULT 0,
    "registration_opens_at" TIMESTAMPTZ(6),
    "registration_closes_at" TIMESTAMPTZ(6),
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "collect_food_preference" BOOLEAN NOT NULL DEFAULT true,
    "collect_photo" BOOLEAN NOT NULL DEFAULT false,
    "collect_gov_id" BOOLEAN NOT NULL DEFAULT false,
    "terms_version" VARCHAR(20) NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventPriceTiers" (
    "id" BIGSERIAL NOT NULL,
    "event_id" BIGINT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "member_price" DECIMAL(14,2) NOT NULL,
    "non_member_price" DECIMAL(14,2) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "EventPriceTiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Events_slug_key" ON "Events"("slug");

-- CreateIndex
CREATE INDEX "Events_status_visibility_start_at_idx" ON "Events"("status", "visibility", "start_at");

-- CreateIndex
CREATE INDEX "EventPriceTiers_event_id_starts_on_idx" ON "EventPriceTiers"("event_id", "starts_on");

-- AddForeignKey
ALTER TABLE "EventPriceTiers" ADD CONSTRAINT "EventPriceTiers_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "Events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written half: guards Prisma cannot express, plus comments (ADR-013).
-- ---------------------------------------------------------------------------

-- Dates must make sense on their own, independent of application code.
ALTER TABLE "Events" ADD CONSTRAINT "Events_end_after_start"
  CHECK ("end_at" > "start_at");
ALTER TABLE "Events" ADD CONSTRAINT "Events_registration_closes_before_start"
  CHECK ("registration_closes_at" IS NULL OR "registration_closes_at" <= "start_at");
ALTER TABLE "Events" ADD CONSTRAINT "Events_registration_window_ordered"
  CHECK ("registration_opens_at" IS NULL OR "registration_closes_at" IS NULL
         OR "registration_closes_at" >= "registration_opens_at");
ALTER TABLE "Events" ADD CONSTRAINT "Events_capacity_positive"
  CHECK ("capacity" IS NULL OR "capacity" > 0);
ALTER TABLE "Events" ADD CONSTRAINT "Events_seats_taken_non_negative"
  CHECK ("seats_taken" >= 0);

-- The backstop behind the guarded UPDATE in the registration transaction. If any
-- other code path ever writes seats_taken, overselling fails loudly here rather
-- than quietly selling the same seat twice.
ALTER TABLE "Events" ADD CONSTRAINT "Events_seats_within_capacity"
  CHECK ("capacity" IS NULL OR "seats_taken" <= "capacity");

-- Integer enum codes are only meaningful in range.
ALTER TABLE "Events" ADD CONSTRAINT "Events_visibility_range"
  CHECK ("visibility" IN (0, 1));
ALTER TABLE "Events" ADD CONSTRAINT "Events_status_range"
  CHECK ("status" IN (0, 1, 2, 3));

-- Tax is a percentage, not an amount.
ALTER TABLE "Events" ADD CONSTRAINT "Events_tax_rate_range"
  CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);

-- At most one actor per audit event. Both NULL means the system did it.
ALTER TABLE "Events" ADD CONSTRAINT "Events_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "Events" ADD CONSTRAINT "Events_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

ALTER TABLE "EventPriceTiers" ADD CONSTRAINT "EventPriceTiers_dates_ordered"
  CHECK ("ends_on" >= "starts_on");
ALTER TABLE "EventPriceTiers" ADD CONSTRAINT "EventPriceTiers_member_price_non_negative"
  CHECK ("member_price" >= 0);
ALTER TABLE "EventPriceTiers" ADD CONSTRAINT "EventPriceTiers_non_member_price_non_negative"
  CHECK ("non_member_price" >= 0);
ALTER TABLE "EventPriceTiers" ADD CONSTRAINT "EventPriceTiers_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "EventPriceTiers" ADD CONSTRAINT "EventPriceTiers_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

-- Two tiers for one event can never cover the same day. Without this, "today's
-- price" would be ambiguous and the answer would depend on row order — the kind
-- of bug that only shows up as a billing dispute. btree_gist is installed by M0.
ALTER TABLE "EventPriceTiers" ADD CONSTRAINT "EventPriceTiers_no_overlapping_windows"
  EXCLUDE USING gist (
    "event_id" WITH =,
    daterange("starts_on", "ends_on", '[]') WITH &&
  );

COMMENT ON TABLE "Events" IS 'An association event. Created as a draft, published to an audience, and priced through EventPriceTiers rather than a fee column.';
COMMENT ON COLUMN "Events"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Events"."slug" IS 'URL-safe identifier used in public links, so a link never exposes a row id.';
COMMENT ON COLUMN "Events"."title" IS 'Shown wherever the event is listed.';
COMMENT ON COLUMN "Events"."description" IS 'Long description, rendered on the detail page.';
COMMENT ON COLUMN "Events"."banner_path" IS 'Storage key of the banner image, through @helpers/storage.';
COMMENT ON COLUMN "Events"."start_at" IS 'Event start (UTC).';
COMMENT ON COLUMN "Events"."end_at" IS 'Event end (UTC). CHECK end_at > start_at.';
COMMENT ON COLUMN "Events"."venue_name" IS 'Venue name as it appears on the invitation.';
COMMENT ON COLUMN "Events"."venue_address_line1" IS 'Street address, line 1.';
COMMENT ON COLUMN "Events"."venue_address_line2" IS 'Street address, line 2.';
COMMENT ON COLUMN "Events"."city" IS 'City. Free text rather than an FK to Cities: a venue may sit outside the master list, and this is a printed address.';
COMMENT ON COLUMN "Events"."state" IS 'State.';
COMMENT ON COLUMN "Events"."pincode" IS 'Postal code.';
COMMENT ON COLUMN "Events"."country" IS 'Country.';
COMMENT ON COLUMN "Events"."map_url" IS 'Optional map link shown on the detail page.';
COMMENT ON COLUMN "Events"."visibility" IS '0 = MEMBER_ONLY, 1 = PUBLIC. Member-only events are absent from public queries rather than fetched and hidden.';
COMMENT ON COLUMN "Events"."status" IS '0 = DRAFT, 1 = PUBLISHED, 2 = CANCELLED, 3 = COMPLETED.';
COMMENT ON COLUMN "Events"."tax_rate" IS 'GST or other tax applied on top of the tier price, percent, 2dp.';
COMMENT ON COLUMN "Events"."capacity" IS 'Total seats. NULL means unlimited.';
COMMENT ON COLUMN "Events"."seats_taken" IS 'Seats consumed by live registrations. Maintained by one guarded UPDATE inside the registration transaction, never read-then-write.';
COMMENT ON COLUMN "Events"."registration_opens_at" IS 'When registration opens. NULL means as soon as it is published.';
COMMENT ON COLUMN "Events"."registration_closes_at" IS 'When registration closes. Must be on or before the event starts.';
COMMENT ON COLUMN "Events"."requires_approval" IS 'When true, a registration waits for admin approval before an invoice exists.';
COMMENT ON COLUMN "Events"."collect_food_preference" IS 'Collect Veg/Non-veg/Jain per delegate.';
COMMENT ON COLUMN "Events"."collect_photo" IS 'Collect a badge photo per delegate.';
COMMENT ON COLUMN "Events"."collect_gov_id" IS 'Collect a government ID per delegate.';
COMMENT ON COLUMN "Events"."terms_version" IS 'Version of the terms shown at booking; copied onto each registration so an old booking proves which policy was accepted.';
COMMENT ON COLUMN "Events"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Events"."created_by_user_id" IS 'Member login that created this row. Always NULL today; events are staff-made.';
COMMENT ON COLUMN "Events"."created_by_admin_id" IS 'Staff account that created this row.';
COMMENT ON COLUMN "Events"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Events"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "Events"."updated_by_admin_id" IS 'Staff account that last changed this row.';
COMMENT ON COLUMN "Events"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means live; all reads filter on it.';

COMMENT ON TABLE "EventPriceTiers" IS 'One price window for one event, with a member and a non-member price. An exclusion constraint guarantees windows never overlap, so today''s price always has exactly one answer.';
COMMENT ON COLUMN "EventPriceTiers"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "EventPriceTiers"."event_id" IS 'FK to Events.id. ON DELETE CASCADE — a tier is meaningless without its event.';
COMMENT ON COLUMN "EventPriceTiers"."name" IS 'Label shown to the buyer: Early bird, Regular, Late.';
COMMENT ON COLUMN "EventPriceTiers"."starts_on" IS 'First day this price applies, inclusive.';
COMMENT ON COLUMN "EventPriceTiers"."ends_on" IS 'Last day this price applies, inclusive — a tier runs to the end of its last day.';
COMMENT ON COLUMN "EventPriceTiers"."member_price" IS 'Price per delegate for a member, INR, 2dp. 0 for a free event.';
COMMENT ON COLUMN "EventPriceTiers"."non_member_price" IS 'Price per delegate for everyone else, INR, 2dp.';
COMMENT ON COLUMN "EventPriceTiers"."display_order" IS 'Ordering on the admin form and the public price table.';
COMMENT ON COLUMN "EventPriceTiers"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "EventPriceTiers"."created_by_user_id" IS 'Member login that created this row. Always NULL today.';
COMMENT ON COLUMN "EventPriceTiers"."created_by_admin_id" IS 'Staff account that created this row.';
COMMENT ON COLUMN "EventPriceTiers"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "EventPriceTiers"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "EventPriceTiers"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMIT;
