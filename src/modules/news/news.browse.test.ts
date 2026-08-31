import { describe, expect, it, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const count = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    newsArticle: {
      findMany: (...a: unknown[]) => findMany(...a),
      count: (...a: unknown[]) => count(...a),
    },
  },
}));

const { listPublishedNews } = await import('@modules/news/news.service');
const { NEWS_STATUS, NEWS_VISIBILITY } = await import('@modules/news/news.constants');

const query = (over: Record<string, unknown> = {}) =>
  ({ page: 1, limit: 12, sort: 'newest', ...over }) as never;

const lastWhere = () => (findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
const lastOrder = () => (findMany.mock.calls[0]?.[0] as { orderBy: unknown }).orderBy;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

/**
 * Browsing the newsroom.
 *
 * The visibility rule is the one that must survive every filter added here: a
 * members-only article is never SELECTED for a logged-out visitor, so no
 * combination of search, category and sort can surface one.
 */
describe('listPublishedNews', () => {
  it('keeps members-only articles out of the public list, whatever else is asked for', async () => {
    await listPublishedNews(query({ search: 'diamond', category: 'updates' }), false);

    expect(lastWhere()).toMatchObject({
      status: NEWS_STATUS.PUBLISHED,
      visibility: NEWS_VISIBILITY.PUBLIC,
    });
  });

  it('drops the visibility filter for a member, and only that', async () => {
    await listPublishedNews(query(), true);

    const where = lastWhere();

    expect(where.status).toBe(NEWS_STATUS.PUBLISHED);
    expect(where).not.toHaveProperty('visibility');
  });

  /** Headline and summary. The body would bury the article the reader meant. */
  it('searches the title and the excerpt, case-insensitively', async () => {
    await listPublishedNews(query({ search: 'Ethiopia' }), false);

    expect(lastWhere().OR).toEqual([
      { title: { contains: 'Ethiopia', mode: 'insensitive' } },
      { excerpt: { contains: 'Ethiopia', mode: 'insensitive' } },
    ]);
  });

  it('adds no OR clause when nothing was searched for', async () => {
    await listPublishedNews(query(), false);

    expect(lastWhere()).not.toHaveProperty('OR');
  });

  it('narrows to one category by slug', async () => {
    await listPublishedNews(query({ category: 'press-releases' }), false);

    expect(lastWhere().category).toEqual({ slug: 'press-releases', deletedAt: null });
  });

  it('sorts newest first by default', async () => {
    await listPublishedNews(query(), false);

    expect(lastOrder()).toEqual([{ published_at: 'desc' }, { id: 'desc' }]);
  });

  /**
   * The tiebreak follows the sort. Two articles published in the same minute
   * would otherwise be free to swap places between page one and page two, and a
   * reader paging through would see one twice and the other never.
   */
  it('reverses the tiebreak with the sort, not just the date', async () => {
    await listPublishedNews(query({ sort: 'oldest' }), false);

    expect(lastOrder()).toEqual([{ published_at: 'asc' }, { id: 'asc' }]);
  });

  it('counts against the same filters it lists with', async () => {
    await listPublishedNews(query({ search: 'gold', category: 'updates' }), false);

    expect(count).toHaveBeenCalledWith({ where: lastWhere() });
  });
});
