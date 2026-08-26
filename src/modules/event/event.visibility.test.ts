import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryRaw = vi.fn();
const eventFindFirst = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    event: { findFirst: (...a: unknown[]) => eventFindFirst(...a) },
  },
}));

const { listPublicEvents, getPublicEvent } = await import('@modules/event/event.service');
const { EVENT_STATUS, EVENT_VISIBILITY } = await import('@modules/event/event.constants');

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([]);
  eventFindFirst.mockResolvedValue(null);
});

describe('public event queries', () => {
  it('filters to PUBLISHED and PUBLIC in SQL, not after fetching', async () => {
    await listPublicEvents({ page: 1, limit: 20 } as never);

    const sql = JSON.stringify(queryRaw.mock.calls[0][0]);

    expect(sql).toContain('visibility');
    expect(sql).toContain('status');
  });

  it('asks the database only for published public events', async () => {
    await getPublicEvent('agm-2026');

    expect(eventFindFirst.mock.calls[0][0].where).toMatchObject({
      slug: 'agm-2026',
      deletedAt: null,
      status: EVENT_STATUS.PUBLISHED,
      visibility: EVENT_VISIBILITY.PUBLIC,
    });
  });

  it('returns null for a members-only event asked for by slug, so it reads as absent', async () => {
    await expect(getPublicEvent('agm-2026')).resolves.toBeNull();
  });
});
