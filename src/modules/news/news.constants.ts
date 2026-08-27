/**
 * Integer enum codes and file limits for the news module.
 *
 * Codes are `smallint` in the database rather than native enums, the convention
 * for tables created from M7 onward, and they are append-only — rows keep
 * whatever number was written into them, so a value is never renumbered or
 * reused. CHECK constraints enforce the ranges.
 */

export const NEWS_VISIBILITY = {
  /** Absent from every public query, not merely hidden after fetching. */
  MEMBER_ONLY: 0,
  /** Listed on the public site; readable without a session. */
  PUBLIC: 1,
} as const;

export type NewsVisibility = (typeof NEWS_VISIBILITY)[keyof typeof NEWS_VISIBILITY];

export const NEWS_STATUS = {
  /** Being written. Invisible to everyone but staff. */
  DRAFT: 0,
  /** Live on the site. */
  PUBLISHED: 1,
  /** Retired from the site, kept in the admin panel and in the record. */
  ARCHIVED: 2,
} as const;

export type NewsStatus = (typeof NEWS_STATUS)[keyof typeof NEWS_STATUS];

/**
 * Formats a browser renders and `@helpers/fileSignature` can identify from its
 * bytes.
 *
 * SVG is deliberately absent, for the reason branding excludes it: an SVG is a
 * script container, and these images are served to logged-out visitors. There is
 * no version of "trusted uploader" that makes shipping arbitrary markup to the
 * public a good idea.
 */
export const NEWS_IMAGE_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** A cover is a wide photograph. Five megabytes is already a generous original. */
export const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** An image inside the body sits in a text column; it does not need to be larger. */
export const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** A press release or a seminar report. Ten megabytes is the hard stop. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * How many files one article may carry.
 *
 * Not a technical limit — a readable one. A foot-of-page list of ten downloads
 * is a filing cabinet, and the reader stops being able to tell which document
 * the article is actually about.
 */
export const MAX_ATTACHMENTS = 6;

/** The homepage Newsroom block. Four cards, as designed. */
export const HOMEPAGE_LIMIT = 4;

/** Listing page size, and the ceiling a caller may ask for. */
export const NEWS_PAGE_SIZE = 12;
export const NEWS_PAGE_SIZE_MAX = 48;
