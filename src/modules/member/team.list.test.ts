import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryRaw = vi.fn();

vi.mock('@db/prisma', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

const { listTeam } = await import('@modules/member/team.service');

beforeEach(() => vi.clearAllMocks());

describe('listTeam', () => {
  it('returns the roster with the owner first and ids as strings', async () => {
    queryRaw.mockResolvedValue([
      {
        id: 1n,
        user_id: 10n,
        full_name: 'Ramesh Shah',
        email: 'ramesh@abc.com',
        designation: 'Director',
        member_role: 0,
        status: 1,
        accepted_at: new Date('2026-01-01'),
      },
      {
        id: 2n,
        user_id: 11n,
        full_name: 'Priya Mehta',
        email: 'priya@abc.com',
        designation: 'Manager',
        member_role: 1,
        status: 0,
        accepted_at: null,
      },
    ]);

    const rows = await listTeam(1042n);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: '1', user_id: '10', member_role: 0 });
    expect(rows[1]).toMatchObject({ id: '2', status: 0, accepted_at: null });
  });

  it('returns an empty array rather than throwing when a firm has no rows', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(listTeam(9999n)).resolves.toEqual([]);
  });
});
