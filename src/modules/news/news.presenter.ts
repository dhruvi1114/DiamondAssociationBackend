import { API_V1, END_POINTS } from '@constant';
import { NEWS_VISIBILITY } from '@modules/news/news.constants';

/**
 * What each audience is allowed to see of an article.
 *
 * Explicit allowlists, not "the row minus a few fields" (M9 definition of done).
 * The difference matters the next time a column is added: an allowlist leaves it
 * out until somebody decides otherwise, and a denylist ships it to the public
 * website by default.
 *
 * There is no email, no phone number and no staff identity in any shape here.
 * The author is deliberately absent from the public view — who inside the office
 * typed a press release is not a fact the association is publishing.
 */

interface CategoryRow {
  id: bigint;
  name: string;
  slug: string;
}

interface AttachmentRow {
  id: bigint;
  public_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: bigint;
  display_order: number;
}

interface ArticleRow {
  id: bigint;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  cover_image_path: string | null;
  cover_image_alt: string | null;
  category_id: bigint | null;
  visibility: number;
  status: number;
  published_at: Date | null;
  attachments?: AttachmentRow[];
  createdAt: Date;
  updatedAt: Date;
  created_by_admin_id: bigint | null;
  category?: CategoryRow | null;
  /** Staff names, resolved by the repository — an id in a column tells nobody anything. */
  created_by?: string | null;
  updated_by?: string | null;
}

const NEWS_BASE = `${API_V1}${END_POINTS.PUBLIC}${END_POINTS.NEWS}` as const;

/**
 * The cover's address.
 *
 * Keyed by slug rather than by id because it is what a share preview and a
 * sitemap image entry carry, and because the endpoint behind it re-checks the
 * article's status and visibility anyway — the URL is a request, not a grant.
 */
export const coverUrl = (slug: string): string => `${NEWS_BASE}/${slug}/cover`;

/**
 * Where one attachment is downloaded from.
 *
 * Keyed by the article's slug AND the file's random id: the slug is what makes
 * the URL readable in a browser's download list, and the id is what stops the
 * set being walked. The endpoint behind it re-checks the article's visibility,
 * so neither half is doing the security work alone.
 */
export const attachmentUrl = (slug: string, publicId: string): string =>
  `${NEWS_BASE}/${slug}/attachments/${publicId}`;

const attachment = (slug: string) => (row: AttachmentRow) => ({
  id: row.id.toString(),
  url: attachmentUrl(slug, row.public_id),
  name: row.original_name,
  mime: row.mime_type,
  size_bytes: Number(row.size_bytes),
});

/** Where an inline image is served from. Written into the body at upload time. */
export const mediaUrl = (publicId: string): string => `${NEWS_BASE}/media/${publicId}`;

const category = (row: CategoryRow | null | undefined) =>
  row ? { id: row.id.toString(), name: row.name, slug: row.slug } : null;

/**
 * A card in the homepage block or the listing.
 *
 * No body: a listing that ships every article's full HTML to draw four cards is
 * a page that gets slower every time the association writes something.
 */
export const toCard = (row: ArticleRow) => ({
  slug: row.slug,
  title: row.title,
  excerpt: row.excerpt,
  cover_url: row.cover_image_path ? coverUrl(row.slug) : null,
  cover_alt: row.cover_image_alt,
  category: category(row.category),
  published_at: row.published_at,
  members_only: row.visibility === NEWS_VISIBILITY.MEMBER_ONLY,
});

/** The article page. */
export const toDetail = (row: ArticleRow) => ({
  ...toCard(row),
  body: row.body,
  /*
    An array, always — empty rather than null. A page that renders "downloads"
    only when the key is present ends up with two shapes to handle for the same
    absence, and the foot of the article simply has nothing to draw.
  */
  attachments: (row.attachments ?? []).map(attachment(row.slug)),
});

/** A neighbour link at the foot of an article. Slug and title, nothing else. */
const neighbour = (row: { slug: string; title: string } | null) =>
  row ? { slug: row.slug, title: row.title } : null;

/**
 * The article, plus the ones either side of it.
 *
 * Separate from `toDetail` because only the reading screen has neighbours —
 * the admin panel and any future digest read the same article without them.
 */
export const toDetailWithNeighbours = (
  row: ArticleRow & {
    neighbours: {
      previous: { slug: string; title: string } | null;
      next: { slug: string; title: string } | null;
    };
  },
) => ({
  ...toDetail(row),
  previous: neighbour(row.neighbours.previous),
  next: neighbour(row.neighbours.next),
});

/**
 * The admin view: everything the panel edits, including what is not public yet.
 *
 * Ids are strings here and everywhere else in this API — a bigint does not
 * survive `JSON.stringify` intact.
 */
export const toAdminRow = (row: ArticleRow) => ({
  id: row.id.toString(),
  slug: row.slug,
  title: row.title,
  excerpt: row.excerpt,
  cover_url: row.cover_image_path ? coverUrl(row.slug) : null,
  cover_alt: row.cover_image_alt,
  category: category(row.category),
  category_id: row.category_id ? row.category_id.toString() : null,
  visibility: row.visibility,
  status: row.status,
  published_at: row.published_at,
  attachments: (row.attachments ?? []).map(attachment(row.slug)),
  created_at: row.createdAt,
  created_by: row.created_by ?? null,
  updated_at: row.updatedAt,
  updated_by: row.updated_by ?? null,
});

export const toAdminDetail = (
  row: ArticleRow,
  images: { id: bigint; public_id: string; original_name: string; size_bytes: bigint }[],
) => ({
  ...toAdminRow(row),
  body: row.body,
  images: images.map((image) => ({
    id: image.id.toString(),
    url: mediaUrl(image.public_id),
    original_name: image.original_name,
    size_bytes: Number(image.size_bytes),
  })),
});

export const toCategory = (row: {
  id: bigint;
  code: string;
  name: string;
  slug: string;
  display_order: number;
  is_active: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: row.id.toString(),
  code: row.code,
  name: row.name,
  slug: row.slug,
  display_order: row.display_order,
  is_active: row.is_active,
  /*
    The timestamps travel with the row because this is a master screen, and on a
    master "when did this last change, and who has been editing the catalogue"
    is the question the list is scanned for. They are not on the public shape —
    a visitor filtering by category has no use for them.
  */
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The filter tabs a visitor sees: no code, no ordering internals. */
export const toPublicCategory = (row: { name: string; slug: string }) => ({
  name: row.name,
  slug: row.slug,
});
