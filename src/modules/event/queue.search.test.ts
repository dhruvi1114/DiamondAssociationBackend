import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryRaw = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}));

const { listRegistrations } = await import('@modules/event/registration.service');
const { listSubmissions } = await import('@modules/event/payment.service');

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([]);
});

/** The Prisma.sql the repository built, as inspectable text plus its values. */
const lastQuery = () => {
  const sql = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };

  return { text: sql.strings.join('?'), values: sql.values };
};

/**
 * The queues match server-side, or they do not match at all.
 *
 * A client-side filter can only see the twenty rows already fetched, so it
 * answers "nothing matched" for a booking reference that exists on page four —
 * the failure is silent and looks exactly like a correct empty result, which is
 * why it is worth a test rather than a glance.
 */
describe('booking queue search', () => {
  it('matches in SQL, across the codes, names and contacts the screen shows', async () => {
    await listRegistrations({ page: 1, limit: 20, search: 'EVT2026' });

    const { text, values } = lastQuery();

    expect(text).toContain('ILIKE');
    expect(text).toContain('registration_code');
    expect(text).toContain('invoice_number');
    // Wrapped for a contains-match, not an equality one: staff paste a fragment.
    expect(values).toContain('%EVT2026%');
  });

  it('binds null when nothing was typed, so the term cannot filter everything out', async () => {
    await listRegistrations({ page: 1, limit: 20 });

    expect(lastQuery().values).toContain(null);
    expect(lastQuery().values.some((v) => typeof v === 'string' && v.includes('%'))).toBe(false);
  });
});

describe('payment queue search and filters', () => {
  it('matches the bank reference in SQL', async () => {
    await listSubmissions({ page: 1, limit: 20, search: 'UTR9911' });

    const { text, values } = lastQuery();

    expect(text).toContain('reference_no');
    expect(text).toContain('ILIKE');
    expect(values).toContain('%UTR9911%');
  });

  it('filters by method in SQL rather than after fetching', async () => {
    await listSubmissions({ page: 1, limit: 20, methods: [0, 1] });

    const { text, values } = lastQuery();

    expect(text).toContain('"method"');
    expect(values).toContainEqual([0, 1]);
  });

  it('leaves the method filter null when none is chosen', async () => {
    await listSubmissions({ page: 1, limit: 20 });

    // Both the method array and the search term bind null — "no opinion".
    expect(lastQuery().values.filter((v) => v === null).length).toBeGreaterThanOrEqual(2);
  });
});
