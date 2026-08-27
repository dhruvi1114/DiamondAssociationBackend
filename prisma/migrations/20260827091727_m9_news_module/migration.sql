-- M9 — News: the association's own writing, published to the public website.
--
-- Three tables. `NewsCategories` is the filter vocabulary, curated by the
-- association for the same reason `EventTypes` is. `NewsArticles` is the article
-- itself. `NewsArticleImages` owns the pictures dropped into an article body, so
-- that an abandoned draft does not leave bytes on disk nothing knows the name of.
--
-- News is NOT a notice and NOT a circular. A circular is a message pushed to
-- chosen members and tracked per recipient (M8, `Notices`); news is a page that
-- sits on the site, is indexed by Google and notifies nobody. Different audience,
-- different lifecycle, different table.
--
-- `visibility` reuses the codes `Events.visibility` already carries — 0
-- MEMBER_ONLY, 1 PUBLIC — deliberately. Two public-facing lists in one system
-- that mean opposite things by the same integer is a bug waiting for the first
-- person who reads one query while thinking of the other.
--
-- The slug is globally unique, INCLUDING across soft-deleted rows, rather than
-- unique-where-live like the masters in M2/M3. A slug is a public address that
-- has been indexed and linked to; freeing it for reuse after a delete means an
-- old bookmark silently starts resolving to a different article. Keeping it taken
-- is the point.

BEGIN;

-- CreateTable
CREATE TABLE "NewsCategories" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(140) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_admin_id" BIGINT,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "NewsCategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsArticles" (
    "id" BIGSERIAL NOT NULL,
    "slug" VARCHAR(180) NOT NULL,
    "title" VARCHAR(220) NOT NULL,
    "excerpt" VARCHAR(400) NOT NULL,
    "body" TEXT NOT NULL,
    "cover_image_path" TEXT,
    "cover_image_alt" VARCHAR(200),
    "category_id" BIGINT,
    "visibility" SMALLINT NOT NULL DEFAULT 1,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ(6),
    "attachment_path" TEXT,
    "attachment_name" VARCHAR(255),
    "attachment_mime" VARCHAR(100),
    "attachment_size" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_admin_id" BIGINT,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "NewsArticles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsArticleImages" (
    "id" BIGSERIAL NOT NULL,
    "article_id" BIGINT NOT NULL,
    "file_path" TEXT NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_admin_id" BIGINT,

    CONSTRAINT "NewsArticleImages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsCategories_code_key" ON "NewsCategories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "NewsCategories_slug_key" ON "NewsCategories"("slug");

-- CreateIndex
CREATE INDEX "NewsCategories_is_active_display_order_idx" ON "NewsCategories"("is_active", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "NewsArticles_slug_key" ON "NewsArticles"("slug");

-- CreateIndex
CREATE INDEX "NewsArticles_status_visibility_published_at_idx" ON "NewsArticles"("status", "visibility", "published_at");

-- CreateIndex
CREATE INDEX "NewsArticles_category_id_status_published_at_idx" ON "NewsArticles"("category_id", "status", "published_at");

-- CreateIndex
CREATE INDEX "NewsArticleImages_article_id_idx" ON "NewsArticleImages"("article_id");

-- AddForeignKey
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "NewsCategories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsArticleImages" ADD CONSTRAINT "NewsArticleImages_article_id_fkey" FOREIGN KEY ("article_id") REFERENCES "NewsArticles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint
--
-- The enum ranges. Codes are append-only; widening one of these is how a new
-- code is added, and no code is ever renumbered or reused.
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_visibility_range"
  CHECK ("visibility" IN (0, 1));
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_status_range"
  CHECK ("status" IN (0, 1, 2));

-- A published or archived article has been live, so it has a date it went live.
-- The listing sorts on that column and the card prints it; a NULL here would be
-- an article that cannot be ordered and cannot be dated, which the screen has no
-- honest way to render.
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_published_has_date"
  CHECK ("status" = 0 OR "published_at" IS NOT NULL);

-- An attachment is a path, a name, a type and a size or it is nothing at all.
-- Half a row here means a download button that resolves to a missing file.
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_attachment_complete"
  CHECK (
    ("attachment_path" IS NULL AND "attachment_name" IS NULL
      AND "attachment_mime" IS NULL AND "attachment_size" IS NULL)
    OR
    ("attachment_path" IS NOT NULL AND "attachment_name" IS NOT NULL
      AND "attachment_mime" IS NOT NULL AND "attachment_size" IS NOT NULL)
  );

ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_attachment_size_positive"
  CHECK ("attachment_size" IS NULL OR "attachment_size" > 0);

ALTER TABLE "NewsArticleImages" ADD CONSTRAINT "NewsArticleImages_size_positive"
  CHECK ("size_bytes" > 0);

-- Blank is not absent. A card with an empty title or an empty summary is a card
-- with a hole in it, and NOT NULL alone does not stop the empty string.
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_title_not_blank"
  CHECK (length(btrim("title")) > 0);
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_excerpt_not_blank"
  CHECK (length(btrim("excerpt")) > 0);
ALTER TABLE "NewsArticles" ADD CONSTRAINT "NewsArticles_slug_not_blank"
  CHECK (length(btrim("slug")) > 0);

-- Comments (ADR-013). Every table and every column, mirroring the `///` doc
-- comments in `prisma/schema/content.prisma`.

COMMENT ON TABLE "NewsCategories" IS 'A label that groups news so a visitor can filter the listing: Press Release, Industry News, Event Coverage, Association Update. A master the association curates rather than a code enum, for the reason `EventTypes` is one: the vocabulary belongs to the trade body, and a list that can only change with a release is a list that quietly stops being used. Deactivated, never deleted, once articles carry it — an article already filed under a category keeps it, so `is_active` says only whether the compose form may still offer it.';
COMMENT ON COLUMN "NewsCategories"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "NewsCategories"."code" IS 'Stable machine name, e.g. PRESS_RELEASE. Immutable once created: reports and any future hard-coded reference read this, not the display name.';
COMMENT ON COLUMN "NewsCategories"."name" IS 'Display name shown in the compose dropdown and on the filter tab, e.g. "Press Release".';
COMMENT ON COLUMN "NewsCategories"."slug" IS 'URL segment for the filter, e.g. press-release in /news?category=press-release. Unique because it addresses the filter; renaming it breaks any link already shared.';
COMMENT ON COLUMN "NewsCategories"."display_order" IS 'Tab order on the listing page. Lower first.';
COMMENT ON COLUMN "NewsCategories"."is_active" IS 'Whether the compose form may still offer it. Existing articles keep theirs regardless.';
COMMENT ON COLUMN "NewsCategories"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "NewsCategories"."created_by_admin_id" IS 'FK to AdminUsers.id — staff account that created this row.';
COMMENT ON COLUMN "NewsCategories"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "NewsCategories"."updated_by_admin_id" IS 'FK to AdminUsers.id — staff account that last changed this row.';
COMMENT ON COLUMN "NewsCategories"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means live; all reads filter on it.';

COMMENT ON TABLE "NewsArticles" IS 'One news article. Written as a draft, then published — there is no scheduled state and no approval chain, because the association asked for draft-and-publish and a status nothing can move a row into is a status that only ever confuses the screen. Archiving rather than deleting is the retirement path: a press release that has been on the public web for two years is a record of what the association said, and removing the row would remove the audit trail of who published it.';
COMMENT ON COLUMN "NewsArticles"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "NewsArticles"."slug" IS 'URL segment, e.g. gjepc-seminar-b2b-e-commerce-delhi. Generated from the title and editable only while the article is a draft: once published the address has been shared, indexed and linked to, and a slug that keeps changing is a site that keeps producing dead links.';
COMMENT ON COLUMN "NewsArticles"."title" IS 'Headline, shown on the card, the article page and the browser tab.';
COMMENT ON COLUMN "NewsArticles"."excerpt" IS 'The two lines printed on the card and used as the meta description and the link preview when the article is shared. Required: a card with no summary is a card with a hole in it, and falling back to the first words of the body produces previews that start mid-sentence.';
COMMENT ON COLUMN "NewsArticles"."body" IS 'The article itself, rich text as HTML. Sanitised on the server before it is written, never on the way out: this markup is served to logged-out browsers, so anything a paste from Word or a compromised staff login could smuggle in has to be gone before it is stored.';
COMMENT ON COLUMN "NewsArticles"."cover_image_path" IS 'Storage key of the cover image, through `@helpers/storage`. Never a public URL — the image is streamed by an endpoint that re-checks the article status and visibility first, so a members-only cover cannot be reached by guessing a path.';
COMMENT ON COLUMN "NewsArticles"."cover_image_alt" IS 'Alt text for the cover: the one image on the page a screen reader cannot skip past, and what a search engine reads the picture as.';
COMMENT ON COLUMN "NewsArticles"."category_id" IS 'FK to NewsCategories.id — which filter tab this appears under. ON DELETE RESTRICT: a category in use cannot be pulled out from under its articles; the master deactivates instead. Nullable so an article can exist before the association has settled on its category list.';
COMMENT ON COLUMN "NewsArticles"."visibility" IS '0 = MEMBER_ONLY, 1 = PUBLIC. Same codes as Events.visibility. Member-only articles are absent from every public query rather than fetched and hidden — a 403 would confirm the article exists, which is itself the information being withheld. PUBLIC by default: most association news is written to be found.';
COMMENT ON COLUMN "NewsArticles"."status" IS '0 = DRAFT, 1 = PUBLISHED, 2 = ARCHIVED.';
COMMENT ON COLUMN "NewsArticles"."published_at" IS 'When the article first went live (UTC). Stamped on the first publish and kept through an unpublish-and-republish, because it is the date printed on the card and the date the listing is ordered by; re-stamping it would move a two-year-old press release back to the top of the homepage after a typo fix.';
COMMENT ON COLUMN "NewsArticles"."attachment_path" IS 'Storage key of the single attached PDF, through `@helpers/storage`. Streamed by an authorised endpoint, never served statically.';
COMMENT ON COLUMN "NewsArticles"."attachment_name" IS 'The uploader''s own filename, shown on the download button. Never used to build a path.';
COMMENT ON COLUMN "NewsArticles"."attachment_mime" IS 'MIME type confirmed by sniffing the file''s magic bytes, not the upload header.';
COMMENT ON COLUMN "NewsArticles"."attachment_size" IS 'Attachment size in bytes, shown beside the download button so a visitor on a phone connection knows what they are about to pull down.';
COMMENT ON COLUMN "NewsArticles"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "NewsArticles"."created_by_admin_id" IS 'FK to AdminUsers.id — staff account that wrote this article.';
COMMENT ON COLUMN "NewsArticles"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "NewsArticles"."updated_by_admin_id" IS 'FK to AdminUsers.id — staff account that last changed it.';
COMMENT ON COLUMN "NewsArticles"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means live; all reads filter on it.';

COMMENT ON TABLE "NewsArticleImages" IS 'An image placed inside an article body. Rows exist so the files are owned by something: the editor uploads a picture the moment it is dropped in, which is before the article is saved and possibly before it is ever published — without a row per upload, every abandoned draft would leave bytes on disk that nothing in the system knows the name of. Deleting the article cascades, so the files can be swept in the same step.';
COMMENT ON COLUMN "NewsArticleImages"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "NewsArticleImages"."article_id" IS 'FK to NewsArticles.id. ON DELETE CASCADE — the image belongs to the article and has no meaning without it.';
COMMENT ON COLUMN "NewsArticleImages"."file_path" IS 'Key in the storage adapter, e.g. news/47/inline-<uuid>.jpg.';
COMMENT ON COLUMN "NewsArticleImages"."original_name" IS 'The uploader''s own filename. Never used to build a path.';
COMMENT ON COLUMN "NewsArticleImages"."mime_type" IS 'MIME type confirmed by sniffing the file''s magic bytes, not the upload header.';
COMMENT ON COLUMN "NewsArticleImages"."size_bytes" IS 'File size in bytes, checked against the ceiling before storing.';
COMMENT ON COLUMN "NewsArticleImages"."checksum_sha256" IS 'SHA-256 of the stored bytes, as for every other stored file.';
COMMENT ON COLUMN "NewsArticleImages"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "NewsArticleImages"."created_by_admin_id" IS 'FK to AdminUsers.id — staff account that uploaded it.';

-- Seed — a starter vocabulary the association is expected to edit; it owns this
-- table now. ON CONFLICT DO NOTHING so re-running is safe and so a row the
-- association has since renamed is never overwritten.
INSERT INTO "NewsCategories" ("code", "name", "slug", "display_order", "updatedAt") VALUES
  ('PRESS_RELEASE',      'Press Release',       'press-release',      1, now()),
  ('INDUSTRY_NEWS',      'Industry News',       'industry-news',      2, now()),
  ('EVENT_COVERAGE',     'Event Coverage',      'event-coverage',     3, now()),
  ('ASSOCIATION_UPDATE', 'Association Update',  'association-update', 4, now()),
  ('MEMBER_ACHIEVEMENT', 'Member Achievement',  'member-achievement', 5, now())
ON CONFLICT ("code") DO NOTHING;

COMMIT;
