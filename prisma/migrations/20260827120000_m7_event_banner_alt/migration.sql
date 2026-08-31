-- M7 — alt text for an event's poster.
--
-- The column the poster itself lives in (`banner_path`) has existed since the
-- events migration and has never been written to: there was no upload path. The
-- public events page is getting one, and an image going onto a public page needs
-- a description for the same two reasons the news cover does — a screen reader
-- cannot skip past it, and a search engine reads the picture as its alt text.
--
-- Nullable. Every event that exists predates the field, and inventing a
-- description of somebody else's poster is worse than admitting there is none.

BEGIN;

ALTER TABLE "Events" ADD COLUMN "banner_alt" VARCHAR(200);

COMMENT ON COLUMN "Events"."banner_alt" IS 'Alt text for the banner. Carried because the poster is the one image on an event card a screen reader cannot skip past, and because it is what a search engine reads the picture as.';

COMMIT;
