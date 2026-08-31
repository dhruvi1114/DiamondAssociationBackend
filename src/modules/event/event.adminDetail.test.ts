import { describe, expect, it, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { event: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));

const { getEvent } = await import('@modules/event/event.service');

const row = (over: Record<string, unknown> = {}) => ({
  id: 7n,
  slug: 'annual-summit',
  title: 'Annual Summit',
  banner_path: 'events/7/banner.png',
  banner_alt: null,
  price_tiers: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(row());
});

/**
 * What the edit drawer is handed.
 *
 * The drawer decides whether to load the poster by looking for `banner_url`, so
 * a raw row meant an event *with* a poster opened showing an empty Upload box.
 * The path is also a storage key, which has no business in a response — the
 * member module drops `file_path` for the same reason.
 */
describe('getEvent, for the admin screens', () => {
  it('hands back a URL the drawer can fetch', async () => {
    const event = await getEvent(7n);

    expect(event.banner_url).toBe('/api/v1/public/events/annual-summit/banner');
  });

  it('never publishes the storage key', async () => {
    const event = await getEvent(7n);

    expect(event).not.toHaveProperty('banner_path');
  });

  it('says null rather than inventing a URL when there is no poster', async () => {
    findFirst.mockResolvedValue(row({ banner_path: null }));

    const event = await getEvent(7n);

    expect(event.banner_url).toBeNull();
  });

  it('404s on an event that is not there', async () => {
    findFirst.mockResolvedValue(null);

    await expect(getEvent(7n)).rejects.toThrow();
  });
});
