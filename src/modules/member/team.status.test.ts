import { describe, expect, it, vi, beforeEach } from 'vitest';

const findTeamRow = vi.fn();
const updateTeamRow = vi.fn();
const writeAudit = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));

vi.mock('@modules/member/team.repository', () => ({
  findTeamRow: (...a: unknown[]) => findTeamRow(...a),
  updateTeamRow: (...a: unknown[]) => updateTeamRow(...a),
  findTeamByMemberId: vi.fn(),
  findUserByEmail: vi.fn(),
  findTeamRowByUserId: vi.fn(),
  createUser: vi.fn(),
  createTeamRow: vi.fn(),
  createInvite: vi.fn(),
}));

vi.mock('@modules/auth/auth.service', () => ({ issueInitialPasswordLink: vi.fn() }));
vi.mock('@helpers/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const { setTeamMemberStatus } = await import('@modules/member/team.service');

const context = { memberId: 1042n, userId: 10n, isOwner: true };
const request = { ip: '127.0.0.1', userAgent: 'test', requestId: 'r1' };

beforeEach(() => {
  vi.clearAllMocks();
  updateTeamRow.mockResolvedValue({ id: 2n, status: 2 });
});

describe('setTeamMemberStatus', () => {
  it('deactivates a team row and stamps deactivated_at', async () => {
    findTeamRow.mockResolvedValue({ id: 2n, member_role: 1, status: 1 });

    const result = await setTeamMemberStatus(2n, { active: false }, context, request);

    expect(updateTeamRow.mock.calls[0][2]).toMatchObject({ status: 2, updated_by_user_id: 10n });
    expect(updateTeamRow.mock.calls[0][2].deactivated_at).toBeInstanceOf(Date);
    expect(result).toMatchObject({ id: '2', status: 2 });
  });

  it('reactivates a team row and clears deactivated_at', async () => {
    findTeamRow.mockResolvedValue({ id: 2n, member_role: 1, status: 2 });
    updateTeamRow.mockResolvedValue({ id: 2n, status: 1 });

    await setTeamMemberStatus(2n, { active: true }, context, request);

    expect(updateTeamRow.mock.calls[0][2]).toMatchObject({ status: 1, deactivated_at: null });
  });

  it('refuses to deactivate the OWNER — a company must always keep one', async () => {
    findTeamRow.mockResolvedValue({ id: 1n, member_role: 0, status: 1 });

    await expect(
      setTeamMemberStatus(1n, { active: false }, context, request),
    ).rejects.toMatchObject({ messageKey: 'member.teamCannotDeactivateOwner' });

    expect(updateTeamRow).not.toHaveBeenCalled();
  });

  it('refuses a row belonging to another company', async () => {
    findTeamRow.mockResolvedValue(null);

    await expect(
      setTeamMemberStatus(999n, { active: false }, context, request),
    ).rejects.toMatchObject({ messageKey: 'member.teamRowNotFound' });
  });
});
