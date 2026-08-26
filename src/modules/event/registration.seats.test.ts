import { describe, expect, it, vi, beforeEach } from 'vitest';
import { takeSeats, releaseSeats } from '@modules/event/registration.repository';

const queryRaw = vi.fn();
const db = { $queryRaw: (...a: unknown[]) => queryRaw(...a) } as never;

beforeEach(() => vi.clearAllMocks());

describe('takeSeats', () => {
  it('returns the new total when the seats were taken', async () => {
    queryRaw.mockResolvedValue([{ seats_taken: 63 }]);

    await expect(takeSeats(db, 1n, 3)).resolves.toBe(63);
  });

  /*
    The contract that matters: no rows means "not enough seats", and that is an
    ordinary answer the caller acts on, not an exception it has to catch. A
    version that threw here would make "sold out" indistinguishable from a
    database outage.
  */
  it('returns null rather than throwing when the seats were refused', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(takeSeats(db, 1n, 3)).resolves.toBeNull();
  });

  it('decides and writes in ONE statement — never read-then-write', async () => {
    queryRaw.mockResolvedValue([{ seats_taken: 1 }]);

    await takeSeats(db, 1n, 1);

    expect(queryRaw).toHaveBeenCalledOnce();

    // `.strings` is the SQL text of the tagged template; JSON.stringify would
    // choke on the bigint sitting in `.values`.
    const sql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join(' ');

    expect(sql).toContain('UPDATE');
    expect(sql).toContain('capacity');
    expect(sql).toContain('RETURNING');
  });
});

describe('releaseSeats', () => {
  it('returns the new total when seats went back', async () => {
    queryRaw.mockResolvedValue([{ seats_taken: 0 }]);

    await expect(releaseSeats(db, 1n, 1)).resolves.toBe(0);
  });

  /*
    The sweep job releases many holds in a row. One already-released booking must
    not stop the rest, so this is null rather than a throw.
  */
  it('returns null when there was nothing to release', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(releaseSeats(db, 1n, 5)).resolves.toBeNull();
  });

  it('guards against driving the counter negative', async () => {
    queryRaw.mockResolvedValue([{ seats_taken: 0 }]);

    await releaseSeats(db, 1n, 2);

    const sql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join(' ');

    expect(sql).toContain('"seats_taken" >= ');
  });
});
