import { describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn();

vi.mock('@db/prisma', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

const { listInvoicesAdmin } = await import('@modules/member/member.service');

describe('listInvoicesAdmin', () => {
  it('returns rows and reads total off the windowed count', async () => {
    queryRaw.mockResolvedValue([
      { id: 1n, invoice_number: 'IN202603001', status: 'PAID', total: 3n },
      { id: 2n, invoice_number: 'IN202603002', status: 'ISSUED', total: 3n },
    ]);

    const result = await listInvoicesAdmin({
      page: 1,
      limit: 20,
      sortBy: 'issue_date',
      sortOrder: 'desc',
    });

    expect(result.rows).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it('returns total 0 on an empty page rather than throwing', async () => {
    queryRaw.mockResolvedValue([]);

    const result = await listInvoicesAdmin({
      page: 1,
      limit: 20,
      sortBy: 'issue_date',
      sortOrder: 'desc',
    });

    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });
});
