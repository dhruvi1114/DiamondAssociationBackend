-- Enquiries from the public contact form.
--
-- The row is written before the office is emailed. A message that only ever
-- existed as an email is gone the moment SMTP fails, and nobody ever learns it
-- was sent -- which is the failure a contact form cannot be allowed to have.
CREATE TABLE "ContactEnquiries" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" VARCHAR(150) NOT NULL,
  "email" VARCHAR(200) NOT NULL,
  "phone" VARCHAR(20),
  "subject" VARCHAR(200) NOT NULL,
  "message" TEXT NOT NULL,
  -- 0 = NEW, 1 = HANDLED. Two states on purpose: a to-do list, not a helpdesk.
  "status" SMALLINT NOT NULL DEFAULT 0,
  "handled_by_admin_id" BIGINT,
  "handled_at" TIMESTAMPTZ(6),
  -- For abuse investigation only. Never shown beside the message: an IP address
  -- tells the person reading an enquiry nothing about the enquiry.
  "ip" VARCHAR(64),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMPTZ(6)
);

ALTER TABLE "ContactEnquiries"
  ADD CONSTRAINT "ContactEnquiries_handled_by_admin_id_fkey"
  FOREIGN KEY ("handled_by_admin_id") REFERENCES "AdminUsers"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- The queue is read newest-first within a status, which is the only way it is
-- ever read.
CREATE INDEX "ContactEnquiries_status_createdAt_idx"
  ON "ContactEnquiries"("status", "createdAt" DESC);

CREATE INDEX "ContactEnquiries_handled_by_admin_id_idx"
  ON "ContactEnquiries"("handled_by_admin_id");

-- The office's phone number, alongside the address and support email already
-- here. Public, because the whole point is that a visitor can read it.
INSERT INTO "SystemSettings" ("key", "value", "value_type", "group", "description", "is_public", "createdAt", "updatedAt")
VALUES (
  'organisation.phone',
  '',
  'STRING',
  'organisation',
  'Office telephone number shown on the public contact page. Blank until the client supplies it.',
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("key") DO NOTHING;

-- Where a reply should go, when that is not the sending account.
--
-- A contact enquiry is sent by the platform but is about a visitor. Without
-- this, the office pressing Reply writes to the no-reply address and the person
-- who asked the question never hears back.
ALTER TABLE "Notifications"
  ADD COLUMN "reply_to" VARCHAR(200);

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Added after the fact: this migration shipped without them, which left the
-- db:check-comments gate red and therefore unable to catch the NEXT omission.
-- ============================================================================

COMMENT ON COLUMN "Notifications"."reply_to" IS 'Where a reply should go, when that is not the sending account. Exists for messages the platform sends *on somebody''s behalf* -- a contact enquiry is from the platform but about a visitor, and without this the office pressing Reply writes to the no-reply account instead of them.';
COMMENT ON TABLE "ContactEnquiries" IS 'An enquiry sent from the public contact form. Stored before the office is emailed, and that order is the point: a message that only ever existed as an email is lost the moment SMTP fails, and nobody ever learns it was sent. The row survives any mail failure, and the outbox retries the notification on its own. Not tied to a member. Most people who use this form are not members yet -- that is usually why they are writing. A message from the public contact form. The row is written before the office is emailed. A message that only ever existed as an email is gone the moment SMTP fails, and nobody ever learns it was sent — which is the one failure a contact form cannot be allowed to have.';
COMMENT ON COLUMN "ContactEnquiries"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "ContactEnquiries"."name" IS 'Sender''s name, as typed.';
COMMENT ON COLUMN "ContactEnquiries"."email" IS 'Sender''s email. Where a reply goes, so it is required even though the rest of the form is forgiving.';
COMMENT ON COLUMN "ContactEnquiries"."phone" IS 'Optional phone. Some enquirers would rather be called than written to.';
COMMENT ON COLUMN "ContactEnquiries"."subject" IS 'What it is about, in the sender''s words.';
COMMENT ON COLUMN "ContactEnquiries"."message" IS 'The enquiry itself.';
COMMENT ON COLUMN "ContactEnquiries"."status" IS '0 = NEW, 1 = HANDLED. Deliberately two states: this is a to-do list, not a helpdesk, and a third state would need someone to define what it means.';
COMMENT ON COLUMN "ContactEnquiries"."handled_by_admin_id" IS 'Staff account that dealt with it. NULL while still NEW.';
COMMENT ON COLUMN "ContactEnquiries"."handled_at" IS 'When it was marked dealt with.';
COMMENT ON COLUMN "ContactEnquiries"."ip" IS 'Where it came from. Kept for abuse investigation only -- never displayed beside the message, because an IP tells staff nothing about the enquiry.';
COMMENT ON COLUMN "ContactEnquiries"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "ContactEnquiries"."updatedAt" IS 'Last modification timestamp (UTC). Carries a DB default as well as Prisma''s `@updatedAt`, matching the migration that created the column.';
COMMENT ON COLUMN "ContactEnquiries"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active.';
