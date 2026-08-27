-- M9 — an article may carry several attachments, not one.
--
-- The four `attachment_*` columns were a single slot, and a single slot forces
-- the writer to choose: an association publishing a circular attaches the
-- circular, its annexure and the form to fill in, and only one of the three
-- could reach the reader.
--
-- The existing rows are carried across before the columns go. There is no
-- "start again" path here even in development — an attachment is a file the
-- association uploaded, and the row is the only record of what its original
-- filename was.
--
-- `display_order` starts at 0 for the migrated file, so it stays first when
-- more are added beside it.

BEGIN;

CREATE TABLE "NewsArticleAttachments" (
    "id" BIGSERIAL NOT NULL,
    "article_id" BIGINT NOT NULL,
    "public_id" UUID NOT NULL,
    "file_path" TEXT NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "checksum_sha256" CHAR(64) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_admin_id" BIGINT,

    CONSTRAINT "NewsArticleAttachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NewsArticleAttachments_public_id_key"
  ON "NewsArticleAttachments"("public_id");

CREATE INDEX "NewsArticleAttachments_article_id_display_order_idx"
  ON "NewsArticleAttachments"("article_id", "display_order");

ALTER TABLE "NewsArticleAttachments" ADD CONSTRAINT "NewsArticleAttachments_article_id_fkey"
  FOREIGN KEY ("article_id") REFERENCES "NewsArticles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NewsArticleAttachments" ADD CONSTRAINT "NewsArticleAttachments_size_positive"
  CHECK ("size_bytes" > 0);

-- Carry the existing single attachments over.
--
-- The checksum is not recoverable from the old columns — it was never stored on
-- the article — so migrated rows get 64 zeroes, which is not a valid SHA-256 of
-- anything and therefore reads as "unknown" rather than as a wrong answer.
INSERT INTO "NewsArticleAttachments"
  ("article_id", "public_id", "file_path", "original_name", "mime_type", "size_bytes",
   "checksum_sha256", "display_order", "created_by_admin_id")
SELECT
  "id",
  gen_random_uuid(),
  "attachment_path",
  COALESCE("attachment_name", 'attachment.pdf'),
  COALESCE("attachment_mime", 'application/pdf'),
  COALESCE("attachment_size", 1),
  repeat('0', 64),
  0,
  "created_by_admin_id"
FROM "NewsArticles"
WHERE "attachment_path" IS NOT NULL;

-- The constraints go before the columns they mention, or the drop is refused.
ALTER TABLE "NewsArticles" DROP CONSTRAINT IF EXISTS "NewsArticles_attachment_complete";
ALTER TABLE "NewsArticles" DROP CONSTRAINT IF EXISTS "NewsArticles_attachment_size_positive";

ALTER TABLE "NewsArticles" DROP COLUMN "attachment_path";
ALTER TABLE "NewsArticles" DROP COLUMN "attachment_name";
ALTER TABLE "NewsArticles" DROP COLUMN "attachment_mime";
ALTER TABLE "NewsArticles" DROP COLUMN "attachment_size";

COMMENT ON TABLE "NewsArticleAttachments" IS 'A file offered for download at the foot of an article. A table rather than four columns on the article, because an association publishing a circular attaches the circular, its annexure and the form to fill in — and a single slot forces the writer to choose which of the three the reader gets. Ordered by display_order, so a covering letter can be listed before the annexure it refers to rather than in upload order.';
COMMENT ON COLUMN "NewsArticleAttachments"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "NewsArticleAttachments"."article_id" IS 'FK to NewsArticles.id. ON DELETE CASCADE — the file belongs to the article and has no meaning without it.';
COMMENT ON COLUMN "NewsArticleAttachments"."public_id" IS 'The address this file is downloaded from, e.g. /api/v1/public/news/<slug>/attachments/<public_id>. Random rather than the row id, for the reason the inline images carry one: an enumerable /attachments/1 would walk every file on every unpublished draft. The endpoint checks the parent article''s visibility as well, so this is a second lock rather than the only one.';
COMMENT ON COLUMN "NewsArticleAttachments"."file_path" IS 'Key in the storage adapter, e.g. news/47/<uuid>.pdf. Never a public URL — downloads go through an authorised endpoint.';
COMMENT ON COLUMN "NewsArticleAttachments"."original_name" IS 'The uploader''s own filename, shown on the download button. Never used to build a path.';
COMMENT ON COLUMN "NewsArticleAttachments"."mime_type" IS 'MIME type confirmed by sniffing the file''s magic bytes, not the upload header.';
COMMENT ON COLUMN "NewsArticleAttachments"."size_bytes" IS 'File size in bytes, shown beside the download button so a reader on a phone connection knows what they are about to pull down.';
COMMENT ON COLUMN "NewsArticleAttachments"."checksum_sha256" IS 'SHA-256 of the stored bytes, as for every other stored file. Rows migrated from the older single-attachment columns carry 64 zeroes, which is not a valid digest of anything and so reads as unknown rather than as a wrong answer.';
COMMENT ON COLUMN "NewsArticleAttachments"."display_order" IS 'Order shown under the article. Lower first.';
COMMENT ON COLUMN "NewsArticleAttachments"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "NewsArticleAttachments"."created_by_admin_id" IS 'FK to AdminUsers.id — staff account that uploaded it.';

COMMIT;
