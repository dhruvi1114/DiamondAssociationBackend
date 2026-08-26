import { describe, expect, it, vi, beforeEach } from 'vitest';

const createMember = vi.fn();
const createOwnerTeamRow = vi.fn();
const recordStatusChange = vi.fn();
const findMemberByUserId = vi.fn();
const userFindFirst = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
    user: { findFirst: (...a: unknown[]) => userFindFirst(...a) },
  },
}));

vi.mock('@modules/member/member.repository', () => ({
  createMember: (...a: unknown[]) => createMember(...a),
  createOwnerTeamRow: (...a: unknown[]) => createOwnerTeamRow(...a),
  recordStatusChange: (...a: unknown[]) => recordStatusChange(...a),
  findMemberByUserId: (...a: unknown[]) => findMemberByUserId(...a),
  findMemberDetail: vi.fn(),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: vi.fn() }));

const { getOrCreateOwnMember } = await import('@modules/member/member.service');
const { MEMBER_ROLE, MEMBER_USER_STATUS } = await import('@modules/member/team.constants');

const actor = { id: 77n, ip: null, userAgent: null, requestId: null };

beforeEach(() => {
  vi.clearAllMocks();
  findMemberByUserId.mockResolvedValue(null);
  userFindFirst.mockResolvedValue({ id: 77n, full_name: 'Ramesh Shah' });
  createMember.mockResolvedValue({ id: 1042n, company_name: 'Ramesh Shah', status: 'DRAFT' });
});

describe('getOrCreateOwnMember', () => {
  it('creates the OWNER MemberUsers row alongside the company', async () => {
    await getOrCreateOwnMember(77n, actor);

    expect(createOwnerTeamRow).toHaveBeenCalledOnce();
    expect(createOwnerTeamRow.mock.calls[0][1]).toMatchObject({
      member_id: 1042n,
      user_id: 77n,
      member_role: MEMBER_ROLE.OWNER,
      status: MEMBER_USER_STATUS.ACTIVE,
    });
  });

  it('returns the existing company without provisioning twice', async () => {
    findMemberByUserId.mockResolvedValue({ id: 1042n });

    const result = await getOrCreateOwnMember(77n, actor);

    expect(result).toEqual({ id: 1042n });
    expect(createMember).not.toHaveBeenCalled();
    expect(createOwnerTeamRow).not.toHaveBeenCalled();
  });
});
