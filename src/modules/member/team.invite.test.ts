import { describe, expect, it, vi, beforeEach } from 'vitest';

const findUserByEmail = vi.fn();
const findTeamRowByUserId = vi.fn();
const createUser = vi.fn();
const createTeamRow = vi.fn();
const createInvite = vi.fn();
const issueInitialPasswordLink = vi.fn();
const writeAudit = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { $transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));

vi.mock('@modules/member/team.repository', () => ({
  findUserByEmail: (...a: unknown[]) => findUserByEmail(...a),
  findTeamRowByUserId: (...a: unknown[]) => findTeamRowByUserId(...a),
  createUser: (...a: unknown[]) => createUser(...a),
  createTeamRow: (...a: unknown[]) => createTeamRow(...a),
  createInvite: (...a: unknown[]) => createInvite(...a),
  findTeamByMemberId: vi.fn(),
}));

vi.mock('@modules/auth/auth.service', () => ({
  issueInitialPasswordLink: (...a: unknown[]) => issueInitialPasswordLink(...a),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const { inviteTeamMember } = await import('@modules/member/team.service');

const context = { memberId: 1042n, userId: 10n, isOwner: true };
const request = { ip: '127.0.0.1', userAgent: 'test', requestId: 'r1' };

beforeEach(() => {
  vi.clearAllMocks();
  findUserByEmail.mockResolvedValue(null);
  findTeamRowByUserId.mockResolvedValue(null);
  createUser.mockResolvedValue({ id: 11n, email: 'priya@abc.com', full_name: 'Priya Mehta' });
  createTeamRow.mockResolvedValue({ id: 2n, user_id: 11n, member_role: 1, status: 0 });
  createInvite.mockResolvedValue({ id: 5n });
});

describe('inviteTeamMember', () => {
  it('creates a passwordless login, an INVITED team row and sends the set-password link', async () => {
    const result = await inviteTeamMember(
      { full_name: 'Priya Mehta', email: 'priya@abc.com', designation: 'Manager' },
      context,
      request,
    );

    expect(createTeamRow.mock.calls[0][1]).toMatchObject({
      member_id: 1042n,
      user_id: 11n,
      member_role: 1,
      status: 0,
      invited_by_user_id: 10n,
      created_by_user_id: 10n,
    });

    expect(createInvite.mock.calls[0][1]).toMatchObject({
      member_id: 1042n,
      user_id: 11n,
      email: 'priya@abc.com',
      designation: 'Manager',
    });
    expect(createInvite.mock.calls[0][1].expires_at).toBeInstanceOf(Date);

    expect(issueInitialPasswordLink).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ id: '2', user_id: '11', status: 0, member_role: 1 });
  });

  it('rejects an address already on this firm roster', async () => {
    findUserByEmail.mockResolvedValue({ id: 11n, email: 'priya@abc.com', full_name: 'Priya' });
    findTeamRowByUserId.mockResolvedValue({ id: 2n });

    await expect(
      inviteTeamMember({ full_name: 'Priya Mehta', email: 'priya@abc.com' }, context, request),
    ).rejects.toMatchObject({ messageKey: 'member.teamEmailAlreadyOnTeam' });

    expect(createTeamRow).not.toHaveBeenCalled();
  });

  it('rejects an address already belonging to a different company', async () => {
    findUserByEmail.mockResolvedValue({ id: 99n, email: 'x@other.com', full_name: 'X' });
    findTeamRowByUserId.mockResolvedValue(null);

    await expect(
      inviteTeamMember({ full_name: 'X', email: 'x@other.com' }, context, request),
    ).rejects.toMatchObject({ messageKey: 'member.teamEmailInUse' });

    expect(createUser).not.toHaveBeenCalled();
  });
});
