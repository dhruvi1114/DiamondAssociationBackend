-- One list of people per company.
--
-- A contact row is the person: name, job title, email, phone. `user_id` says
-- whether that person also has a login. It is nullable because the common case
-- an association needs is a person who receives correspondence and must not
-- reach the portal -- an accountant, a director who never signs in.
--
-- The access state (invited / active / deactivated) is deliberately NOT copied
-- here. It stays on "MemberUsers" and is read through this link, so there is
-- one place that decides whether somebody can sign in.
ALTER TABLE "MemberContacts"
  ADD COLUMN "user_id" BIGINT;

ALTER TABLE "MemberContacts"
  ADD CONSTRAINT "MemberContacts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "Users"("id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "MemberContacts_user_id_idx" ON "MemberContacts"("user_id");

-- One contact per login per company. Partial, so the many contacts without a
-- login never collide with each other on NULL.
CREATE UNIQUE INDEX "MemberContacts_member_id_user_id_key"
  ON "MemberContacts"("member_id", "user_id")
  WHERE "user_id" IS NOT NULL AND "deletedAt" IS NULL;

-- Order matters. The linking pass runs FIRST: a company that already typed its
-- owner in by hand has a contact carrying the owner's email, and inserting
-- before linking would give that person a second row -- the exact duplicate
-- this whole change exists to remove. Linking first lets the insert's guard see
-- the row and skip it.
-- Existing contacts that are really the same person as a team login get linked
-- rather than left as a duplicate of them. Matched on email, which is the only
-- identifier the two rows ever shared.
UPDATE "MemberContacts" c
   SET "user_id" = u."id"
  FROM "MemberUsers" mu
  JOIN "Users" u ON u."id" = mu."user_id"
 WHERE c."member_id" = mu."member_id"
   AND c."user_id" IS NULL
   AND c."deletedAt" IS NULL
   AND u."deletedAt" IS NULL
   AND lower(c."email") = lower(u."email"::text)
   -- Only when that login is not already claimed by another contact row.
   AND NOT EXISTS (
     SELECT 1 FROM "MemberContacts" c2
      WHERE c2."member_id" = mu."member_id"
        AND c2."user_id" = u."id"
        AND c2."deletedAt" IS NULL
   );

-- Backfill: every existing company gets its owner as a contact.
--
-- Until now signup created a company and a login and no contact at all, so the
-- owner was a person nobody had recorded -- unnamed, unreachable and not
-- editable, because you cannot edit a row that does not exist.
--
-- The name comes from "Users"."full_name", which registration seeds from the
-- company name. So these rows start out named after the company; that is the
-- value that was already on display, and now it can be corrected.
INSERT INTO "MemberContacts" ("member_id", "user_id", "name", "email", "phone", "is_primary", "createdAt", "updatedAt")
SELECT mu."member_id",
       u."id",
       u."full_name",
       u."email"::text,
       u."phone",
       -- Primary only where the company has not already nominated somebody.
       NOT EXISTS (
         SELECT 1 FROM "MemberContacts" c
          WHERE c."member_id" = mu."member_id"
            AND c."is_primary"
            AND c."deletedAt" IS NULL
       ),
       NOW(),
       NOW()
  FROM "MemberUsers" mu
  JOIN "Users" u ON u."id" = mu."user_id"
 WHERE mu."member_role" = 0
   AND u."deletedAt" IS NULL
   -- Never a second row for an owner who somehow already has one.
   AND NOT EXISTS (
     SELECT 1 FROM "MemberContacts" c
      WHERE c."member_id" = mu."member_id"
        AND c."user_id" = u."id"
        AND c."deletedAt" IS NULL
   );
