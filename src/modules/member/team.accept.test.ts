import { describe, expect, it, vi, beforeEach } from 'vitest';

const activateTeamRowForUser = vi.fn();
const acceptInvitesForUser = vi.fn();

vi.mock('@modules/member/team.repository', () => ({
  activateTeamRowForUser: (...a: unknown[]) => activateTeamRowForUser(...a),
  acceptInvitesForUser: (...a: unknown[]) => acceptInvitesForUser(...a),
}));

const { activateInvitedTeamRow } = await import('@modules/member/team.activation');

beforeEach(() => {
  vi.clearAllMocks();
  activateTeamRowForUser.mockResolvedValue({ count: 1 });
  acceptInvitesForUser.mockResolvedValue({ count: 1 });
});

describe('activateInvitedTeamRow', () => {
  it('activates the roster row and closes the invite with the same timestamp', async () => {
    await activateInvitedTeamRow({} as never, 11n);

    expect(activateTeamRowForUser.mock.calls[0][1]).toBe(11n);
    expect(acceptInvitesForUser.mock.calls[0][1]).toBe(11n);

    const stampedOnRow = activateTeamRowForUser.mock.calls[0][2] as Date;
    const stampedOnInvite = acceptInvitesForUser.mock.calls[0][2] as Date;

    expect(stampedOnRow).toBeInstanceOf(Date);
    expect(stampedOnRow.getTime()).toBe(stampedOnInvite.getTime());
  });

  it('is a no-op for a login that was never invited to a team', async () => {
    activateTeamRowForUser.mockResolvedValue({ count: 0 });
    acceptInvitesForUser.mockResolvedValue({ count: 0 });

    await expect(activateInvitedTeamRow({} as never, 12n)).resolves.toBeUndefined();
  });
});
