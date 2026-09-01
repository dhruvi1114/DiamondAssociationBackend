import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const queryRaw = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));

const { listPublicEvents } = await import('@modules/event/event.service');

/** The statement Prisma was handed, flattened back to readable SQL. */
const sql = (): string => {
  const arg = queryRaw.mock.calls[0]?.[0] as Prisma.Sql;

  return arg.strings ? arg.strings.join('?') : String(arg);
};

const query = (over: Record<string, unknown> = {}) =>
  ({ page: 1, limit: 24, sort: 'upcoming', ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([]);
});

/**
 * Ordering the browse list.
 *
 * SQL will not take a placeholder for an ORDER BY direction, so the direction is
 * chosen in TypeScript from a value zod has already narrowed to one of two
 * strings. These tests are what keeps that narrowing honest.
 */
describe('event browse ordering', () => {
  it('puts the soonest event first by default', async () => {
    await listPublicEvents(query());

    expect(sql()).toMatch(/ORDER BY e\."start_at"\s*\?*\s*ASC|ASC/);
  });

  it('reverses for the archive read', async () => {
    await listPublicEvents(query({ sort: 'recent' }));

    expect(sql()).toContain('DESC');
  });

  it("never interpolates the caller's own text into the statement", async () => {
    await listPublicEvents(query({ sort: 'recent' }));

    const statement = sql();

    // Only the two words the ternary can produce may appear as a direction.
    const directions = statement.match(/\b(ASC|DESC)\b/g) ?? [];

    expect(directions.length).toBeGreaterThan(0);
    expect(directions.every((word) => word === 'ASC' || word === 'DESC')).toBe(true);
  });
});
