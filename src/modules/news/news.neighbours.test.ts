import { describe, expect, it, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { newsArticle: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

const { getPublishedArticle } = await import('@modules/news/news.service');
const { NEWS_STATUS, NEWS_VISIBILITY } = await import('@modules/news/news.constants');

const ARTICLE = {
  id: 5n,
  slug: 'here',
  title: 'Here',
  published_at: new Date('2026-08-20T00:00:00Z'),
};

/** call 0 is the article, 1 is the older neighbour, 2 is the newer one. */
const argsOf = (call: number) => findFirst.mock.calls[call]?.[0] as Record<string, never>;

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValueOnce(ARTICLE).mockResolvedValue(null);
});

/**
 * The links at the foot of an article.
 *
 * Both are scoped to the same audience as the article itself. Offering a
 * logged-out reader a "next article" that 404s when they click it is worse than
 * offering them nothing.
 */
describe('getPublishedArticle neighbours', () => {
  it('looks for neighbours a logged-out visitor may actually open', async () => {
    await getPublishedArticle('here', false);

    for (const call of [1, 2]) {
      expect(argsOf(call).where).toMatchObject({
        status: NEWS_STATUS.PUBLISHED,
        visibility: NEWS_VISIBILITY.PUBLIC,
      });
    }
  });

  it('lets a member see members-only articles either side', async () => {
    await getPublishedArticle('here', true);

    for (const call of [1, 2]) {
      expect(argsOf(call).where).not.toHaveProperty('visibility');
    }
  });

  /**
   * Without the id tiebreak, two articles published in the same minute make
   * previous and next disagree about which came first — a reader clicking next
   * then previous does not come back to where they were.
   */
  it('breaks a same-timestamp tie by id, in each direction', async () => {
    await getPublishedArticle('here', false);

    expect(argsOf(1).where.OR).toEqual([
      { published_at: { lt: ARTICLE.published_at } },
      { published_at: ARTICLE.published_at, id: { lt: 5n } },
    ]);
    expect(argsOf(2).where.OR).toEqual([
      { published_at: { gt: ARTICLE.published_at } },
      { published_at: ARTICLE.published_at, id: { gt: 5n } },
    ]);
  });

  it('orders each side so the nearest article is the one found', async () => {
    await getPublishedArticle('here', false);

    expect(argsOf(1).orderBy).toEqual([{ published_at: 'desc' }, { id: 'desc' }]);
    expect(argsOf(2).orderBy).toEqual([{ published_at: 'asc' }, { id: 'asc' }]);
  });

  it('answers null on the ends rather than wrapping round', async () => {
    const article = await getPublishedArticle('here', false);

    expect(article.neighbours).toEqual({ previous: null, next: null });
  });

  it('still 404s an article that is not published', async () => {
    // `clearAllMocks` clears calls but keeps the queued `...Once` value from
    // `beforeEach`, which would still hand back the article.
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);

    await expect(getPublishedArticle('missing', false)).rejects.toThrow();
  });
});
