import { describe, expect, it, vi, beforeEach } from 'vitest';

import { listDirectory } from '@modules/directory/directory.repository';
import type { Db } from '@db/prisma';

const findMany = vi.fn();
const count = vi.fn();

/* The repository takes its client as an argument, so a stub is the whole mock. */
const db = { member: { findMany, count } } as unknown as Db;

const query = (over: Record<string, unknown> = {}) => ({ page: 1, sort: 'az', ...over }) as never;

/** The AND clauses the filter builder produced, read off the query it ran. */
const clauses = (): Record<string, unknown>[] =>
  (findMany.mock.calls[0]?.[0] as { where: { AND: Record<string, unknown>[] } }).where.AND ?? [];

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

/**
 * City and state are independent filters over the primary address.
 *
 * They were one control — a city option carrying its state as a label — which
 * cannot express "everyone in Gujarat". Both reach the query separately, and
 * both scope to the primary address rather than any address a company has ever
 * had.
 */
describe('directory city and state filters', () => {
  it('filters on the primary address city', async () => {
    await listDirectory(db, query({ city: 'Surat' }));

    expect(clauses()).toContainEqual({
      addresses: { some: { is_primary: true, deletedAt: null, city: 'Surat' } },
    });
  });

  it('filters on the primary address state', async () => {
    await listDirectory(db, query({ state: 'Gujarat' }));

    expect(clauses()).toContainEqual({
      addresses: { some: { is_primary: true, deletedAt: null, state: 'Gujarat' } },
    });
  });

  /** Both together narrow to the intersection, not the union. */
  it('applies both as separate clauses when both are given', async () => {
    await listDirectory(db, query({ city: 'Surat', state: 'Gujarat' }));

    const where = clauses();

    expect(where).toHaveLength(2);
    expect(where.some((clause) => JSON.stringify(clause).includes('Surat'))).toBe(true);
    expect(where.some((clause) => JSON.stringify(clause).includes('Gujarat'))).toBe(true);
  });

  it('adds no clause when neither is given', async () => {
    await listDirectory(db, query());

    expect(clauses()).toHaveLength(0);
  });
});
