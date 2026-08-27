-- M7 — give existing member bookings a contact address to be written to.
--
-- `EventRegistrations.contact_email` is where every notice about a booking is
-- addressed: pending payment, the hold reminders, payment verified, the
-- cancellation. A member booking that did not nominate an address left it NULL,
-- and every one of those emails was queued with no recipient and failed with
-- "EMAIL notification has no to_address" — silently, because the in-app copy of
-- the same notice went out fine and nothing on screen said the email had not.
--
-- The booking path now resolves the address at booking time (the nominated one,
-- else the login that booked). This repairs the rows written before it did, so
-- a reminder or a payment confirmation on an existing booking can still be sent.
--
-- Members only. A guest booking always carries the address the guest typed —
-- there is no account behind it to fall back to — so those rows are already
-- correct and are left alone.
--
-- Data only. No table, column or constraint is touched.

BEGIN;

UPDATE "EventRegistrations" r
   SET "contact_email" = u."email",
       "updatedAt" = now()
  FROM "Users" u
 WHERE r."user_id" = u."id"
   AND r."member_id" IS NOT NULL
   AND r."contact_email" IS NULL
   AND r."deletedAt" IS NULL;

-- A booking made before team logins existed may have no user_id. Fall back to
-- the login that owns the company record, which is who the association would
-- write to about it anyway.
UPDATE "EventRegistrations" r
   SET "contact_email" = u."email",
       "updatedAt" = now()
  FROM "Members" m
  JOIN "Users" u ON u."id" = m."primary_user_id"
 WHERE r."member_id" = m."id"
   AND r."contact_email" IS NULL
   AND r."deletedAt" IS NULL;

COMMIT;
