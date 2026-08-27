-- M9 — give each inline news image an unguessable public address.
--
-- The URL for a picture inside an article body is written into the body HTML and
-- is then read by three different audiences: a logged-out visitor, a signed-in
-- member, and the staff member editing the draft. Rewriting that markup per
-- audience would mean the stored article and the served article are different
-- documents, and every future reader of the column would have to know the trick.
--
-- So the URL is the same for everyone and the id in it carries the permission.
-- The row id cannot: /media/1, /media/2 enumerates every picture in every
-- unpublished draft. A v4 UUID is 122 bits of randomness, which is not guessed.
--
-- `gen_random_uuid()` is pgcrypto, built in since PostgreSQL 13. The backfill is
-- there for correctness rather than for data — the table is new — because a
-- migration that only works on an empty table is one that fails the first time
-- it is run anywhere else.

BEGIN;

ALTER TABLE "NewsArticleImages" ADD COLUMN "public_id" UUID;

UPDATE "NewsArticleImages" SET "public_id" = gen_random_uuid() WHERE "public_id" IS NULL;

ALTER TABLE "NewsArticleImages" ALTER COLUMN "public_id" SET NOT NULL;

CREATE UNIQUE INDEX "NewsArticleImages_public_id_key" ON "NewsArticleImages"("public_id");

COMMENT ON COLUMN "NewsArticleImages"."public_id" IS 'The address this image is served at, e.g. /api/v1/public/news/media/<public_id>. A random id rather than the row id, because this URL is written into the article body and has to work for every audience without being rewritten: the same markup is read by a logged-out visitor, by a member and by the staff member editing the draft. An enumerable /media/1, /media/2 would hand a stranger every picture in every unpublished draft; 122 bits of randomness makes the URL itself the permission.';

COMMIT;
