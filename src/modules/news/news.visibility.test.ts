import { describe, expect, it, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const findMany = vi.fn();
const count = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    newsArticle: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      count: (...a: unknown[]) => count(...a),
    },
    newsCategory: { findMany: (...a: unknown[]) => findMany(...a) },
  },
}));

const { getPublishedArticle, listPublishedNews, homepageNews } =
  await import('@modules/news/news.service');
const { NEWS_STATUS, NEWS_VISIBILITY, HOMEPAGE_LIMIT } =
  await import('@modules/news/news.constants');

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

/**
 * The rule the whole module rests on: a member-only article is never SELECTED
 * for a logged-out visitor. Filtering after fetching would work until the day
 * somebody logs the row, caches it or forgets the check — and a 403 would
 * confirm the article exists, which is itself what is being withheld.
 */
describe('public reads', () => {
  it('asks the database only for published, public articles', async () => {
    await expect(getPublishedArticle('gjepc-seminar-delhi', false)).rejects.toThrow();

    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      slug: 'gjepc-seminar-delhi',
      deletedAt: null,
      status: NEWS_STATUS.PUBLISHED,
      visibility: NEWS_VISIBILITY.PUBLIC,
    });
  });

  it('answers a request for a members-only article the same way as for one that does not exist', async () => {
    // The reader returned nothing, so the service raises not-found rather than
    // a forbidden that would leak the article's existence.
    await expect(getPublishedArticle('members-briefing', false)).rejects.toMatchObject({
      messageKey: 'news.notFound',
    });
  });

  it('constrains the listing by visibility in the WHERE clause', async () => {
    await listPublishedNews({ page: 1, limit: 12 } as never, false);

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      status: NEWS_STATUS.PUBLISHED,
      visibility: NEWS_VISIBILITY.PUBLIC,
      deletedAt: null,
    });
  });

  it('never returns a draft, whatever its visibility', async () => {
    await listPublishedNews({ page: 1, limit: 12 } as never, true);

    expect(findMany.mock.calls[0][0].where.status).toBe(NEWS_STATUS.PUBLISHED);
  });
});

describe('member reads', () => {
  it('drops the visibility filter so a member sees member-only articles too', async () => {
    await listPublishedNews({ page: 1, limit: 12 } as never, true);

    const { where } = findMany.mock.calls[0][0];

    expect(where.status).toBe(NEWS_STATUS.PUBLISHED);
    // Not "visibility: MEMBER_ONLY" — a member sees everything a visitor sees,
    // plus the member-only ones. Nothing is subtracted for signing in.
    expect(where.visibility).toBeUndefined();
  });

  it('still refuses a draft asked for by slug', async () => {
    await expect(getPublishedArticle('unfinished', true)).rejects.toThrow();

    expect(findFirst.mock.calls[0][0].where.status).toBe(NEWS_STATUS.PUBLISHED);
  });
});

describe('homepage block', () => {
  it('asks for exactly four, newest first', async () => {
    await homepageNews(false);

    const call = findMany.mock.calls[0][0];

    expect(call.take).toBe(HOMEPAGE_LIMIT);
    expect(call.orderBy[0]).toMatchObject({ published_at: 'desc' });
  });

  it('applies the same public filter as the listing', async () => {
    await homepageNews(false);

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      status: NEWS_STATUS.PUBLISHED,
      visibility: NEWS_VISIBILITY.PUBLIC,
    });
  });
});

describe('category filter', () => {
  it('filters by category slug through the relation, live categories only', async () => {
    await listPublishedNews({ page: 1, limit: 12, category: 'press-release' } as never, false);

    expect(findMany.mock.calls[0][0].where.category).toMatchObject({
      slug: 'press-release',
      deletedAt: null,
    });
  });
});
