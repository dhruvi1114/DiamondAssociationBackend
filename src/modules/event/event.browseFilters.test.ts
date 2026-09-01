import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const listPublicEvents = vi.fn();
const browseFacets = vi.fn();

vi.mock('@modules/event/event.service', () => ({
  listPublicEvents: (...a: unknown[]) => listPublicEvents(...a),
  listMemberEvents: (...a: unknown[]) => listPublicEvents(...a),
  browseFacets: (...a: unknown[]) => browseFacets(...a),
}));

vi.mock('@utils/handleResponse', () => ({ handleApiResponse: vi.fn() }));

const controller = await import('@modules/event/event.controller');

/** Run the browse handler with a query string already parsed by zod. */
const browse = async (query: Record<string, unknown>) => {
  const req = { query, get: () => undefined } as unknown as Request;
  const res = {} as Response;

  await new Promise<void>((resolve, reject) => {
    void (
      controller.listPublicEvents as unknown as (
        q: Request,
        r: Response,
        n: (e?: unknown) => void,
      ) => void
    )(req, res, (error) => (error ? reject(error) : resolve()));

    setTimeout(resolve, 0);
  });

  return (listPublicEvents.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  listPublicEvents.mockResolvedValue({ rows: [], total: 0 });
});

/**
 * The query string, as the repository receives it.
 *
 * Every field is named twice — once as the URL spells it, once as the
 * repository does — and the controller maps between them by hand. A filter
 * added to the schema and the repository but missed here validates, runs, and
 * quietly does nothing. `sort` shipped exactly that way; these tests are what
 * stops the next one.
 */
describe('browse filters reach the repository', () => {
  it('carries the sort direction', async () => {
    const filters = await browse({ page: 1, limit: 24, sort: 'recent' });

    expect(filters.sort).toBe('recent');
  });

  it('renames city to cities and state to states', async () => {
    const filters = await browse({
      page: 1,
      limit: 24,
      city: ['Surat'],
      state: ['Gujarat'],
    });

    expect(filters.cities).toEqual(['Surat']);
    expect(filters.states).toEqual(['Gujarat']);
  });

  it('turns type ids into bigints, which the column is', async () => {
    const filters = await browse({ page: 1, limit: 24, type: ['3', '7'] });

    expect(filters.typeIds).toEqual([3n, 7n]);
  });

  it('carries the price, the dates and the open flag', async () => {
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-12-31T00:00:00.000Z');
    const filters = await browse({ page: 1, limit: 24, price: 'free', from, to, open: true });

    expect(filters.price).toBe('free');
    expect(filters.from).toBe(from);
    expect(filters.to).toBe(to);
    expect(filters.openOnly).toBe(true);
  });
});
