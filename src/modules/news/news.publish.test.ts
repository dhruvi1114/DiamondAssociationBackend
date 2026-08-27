import { describe, expect, it, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
const imageFindMany = vi.fn();
const attachmentFindMany = vi.fn();
const auditCreate = vi.fn();

vi.mock('@db/prisma', () => {
  const tx = {
    newsArticle: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
    newsArticleImage: { findMany: (...a: unknown[]) => imageFindMany(...a) },
    newsArticleAttachment: { findMany: (...a: unknown[]) => attachmentFindMany(...a) },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
  };

  return {
    prisma: {
      ...tx,
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  };
});

vi.mock('@helpers/audit', () => ({ writeAudit: vi.fn() }));

const { publishArticle, archiveArticle, deleteArticle, updateArticle } =
  await import('@modules/news/news.service');
const { NEWS_STATUS, NEWS_VISIBILITY } = await import('@modules/news/news.constants');

const ACTOR = { id: 1n, ip: null, userAgent: null, requestId: null };

const article = (over: Record<string, unknown> = {}) => ({
  id: 47n,
  slug: 'gjepc-seminar-delhi',
  title: 'GJEPC Seminar in Delhi',
  excerpt: 'A summary long enough to be a summary.',
  body: '<p>The seminar was held on Tuesday.</p>',
  cover_image_path: 'news/47/abc.jpg',
  cover_image_alt: null,
  category_id: null,
  visibility: NEWS_VISIBILITY.PUBLIC,
  status: NEWS_STATUS.DRAFT,
  published_at: null,
  attachment_path: null,
  attachment_name: null,
  attachment_mime: null,
  attachment_size: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
  created_by_admin_id: 1n,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue(article());
  // The file sweep that follows a delete: no cover, no attachments, no images.
  findUnique.mockResolvedValue({ cover_image_path: null });
  imageFindMany.mockResolvedValue([]);
  attachmentFindMany.mockResolvedValue([]);
});

/**
 * Publishing is the moment an article becomes something the public sees, so the
 * checks here are about the card it will produce: a headline, a summary, a cover
 * and a body. A card missing any of those is a hole on the homepage that only
 * strangers notice.
 */
describe('publish', () => {
  it('refuses an article with no cover image', async () => {
    findFirst.mockResolvedValue(article({ cover_image_path: null }));

    await expect(publishArticle(47n, ACTOR)).rejects.toMatchObject({
      messageKey: 'news.coverRequired',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an article whose body is only empty markup', async () => {
    findFirst.mockResolvedValue(article({ body: '<p><br></p>' }));

    await expect(publishArticle(47n, ACTOR)).rejects.toMatchObject({
      messageKey: 'news.bodyRequired',
    });
  });

  it('stamps the publish date on the first publish', async () => {
    findFirst.mockResolvedValue(article());

    await publishArticle(47n, ACTOR);

    const data = update.mock.calls[0][0].data;

    expect(data.status).toBe(NEWS_STATUS.PUBLISHED);
    expect(data.published_at).toBeInstanceOf(Date);
  });

  it('keeps the original publish date when a corrected article goes back up', async () => {
    const first = new Date('2024-03-02T10:00:00Z');

    findFirst.mockResolvedValue(article({ status: NEWS_STATUS.DRAFT, published_at: first }));

    await publishArticle(47n, ACTOR);

    // Re-stamping would jump a two-year-old press release back to the top of
    // the homepage because somebody fixed a typo.
    expect(update.mock.calls[0][0].data.published_at).toBe(first);
  });

  it('refuses to publish twice', async () => {
    findFirst.mockResolvedValue(article({ status: NEWS_STATUS.PUBLISHED }));

    await expect(publishArticle(47n, ACTOR)).rejects.toMatchObject({
      messageKey: 'news.alreadyPublished',
    });
  });
});

describe('the slug after publication', () => {
  it('refuses to change the address of a published article', async () => {
    findFirst.mockResolvedValue(article({ status: NEWS_STATUS.PUBLISHED }));

    await expect(
      updateArticle(47n, { ...article(), slug: 'a-different-address' } as never, ACTOR),
    ).rejects.toMatchObject({ messageKey: 'news.slugLockedAfterPublish' });
  });
});

describe('retirement', () => {
  it('refuses to archive something that was never published', async () => {
    findFirst.mockResolvedValue(article({ status: NEWS_STATUS.DRAFT }));

    await expect(archiveArticle(47n, ACTOR)).rejects.toMatchObject({
      messageKey: 'news.draftCannotArchive',
    });
  });

  it('refuses to delete anything that has been on the public web', async () => {
    findFirst.mockResolvedValue(article({ status: NEWS_STATUS.PUBLISHED }));

    await expect(deleteArticle(47n, ACTOR)).rejects.toMatchObject({
      messageKey: 'news.onlyDraftsDeletable',
    });
  });

  it('soft-deletes a draft rather than removing the row', async () => {
    findFirst.mockResolvedValue(article({ status: NEWS_STATUS.DRAFT }));

    await deleteArticle(47n, ACTOR);

    expect(update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });
});
