import { describe, expect, it, vi, beforeEach } from 'vitest';

const findUserByEmail = vi.fn();
const findTeamRowByUserId = vi.fn();
const createUser = vi.fn();
const createTeamRow = vi.fn();
const createInvite = vi.fn();
const findContact = vi.fn();
const updateContact = vi.fn();
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

vi.mock('@modules/member/member.repository', () => ({
  findContact: (...a: unknown[]) => findContact(...a),
  updateContact: (...a: unknown[]) => updateContact(...a),
}));

vi.mock('@modules/auth/auth.service', () => ({
  issueInitialPasswordLink: (...a: unknown[]) => issueInitialPasswordLink(...a),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

const { grantContactAccess } = await import('@modules/member/team.service');

const context = { memberId: 1042n, userId: 10n, isOwner: true };
const request = { ip: '127.0.0.1', userAgent: 'test', requestId: 'r1' };

const contact = {
  id: 7n,
  member_id: 1042n,
  user_id: null,
  name: 'Priya Mehta',
  designation: 'Sales',
  email: 'Priya@ABC.com',
  phone: '9825012345',
};

beforeEach(() => {
  vi.clearAllMocks();
  findContact.mockResolvedValue({ ...contact });
  findUserByEmail.mockResolvedValue(null);
  findTeamRowByUserId.mockResolvedValue(null);
  createUser.mockResolvedValue({ id: 11n, email: 'priya@abc.com', full_name: 'Priya Mehta' });
  createTeamRow.mockResolvedValue({ id: 2n, user_id: 11n, member_role: 1, status: 0 });
});

describe('grantContactAccess', () => {
  it('creates the login from the contact already on the list', async () => {
    const row = await grantContactAccess(7n, context, request);

    expect(createUser.mock.calls[0][1]).toMatchObject({
      // Lowercased: the address is the sign-in identifier, and "Priya@ABC.com"
      // and "priya@abc.com" must not be able to become two accounts.
      email: 'priya@abc.com',
      full_name: 'Priya Mehta',
    });
    expect(createInvite.mock.calls[0][1]).toMatchObject({ designation: 'Sales' });
    expect(issueInitialPasswordLink).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ id: '7', user_id: '11', access_status: 0 });
  });

  it('links the contact to the new login, so the two are one person', async () => {
    await grantContactAccess(7n, context, request);

    expect(updateContact).toHaveBeenCalledOnce();
    expect(updateContact.mock.calls[0][1]).toBe(7n);
    expect(updateContact.mock.calls[0][2]).toEqual({ user: { connect: { id: 11n } } });
  });

  it('refuses a contact with no email, which is what the invite would be sent to', async () => {
    findContact.mockResolvedValue({ ...contact, email: null });

    await expect(grantContactAccess(7n, context, request)).rejects.toMatchObject({
      messageKey: 'member.contactEmailRequiredForAccess',
    });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('refuses a contact that already has a login rather than making a second one', async () => {
    findContact.mockResolvedValue({ ...contact, user_id: 11n });

    await expect(grantContactAccess(7n, context, request)).rejects.toMatchObject({
      messageKey: 'member.teamEmailAlreadyOnTeam',
    });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('treats another company’s contact as missing, never as forbidden', async () => {
    findContact.mockResolvedValue(null);

    await expect(grantContactAccess(7n, context, request)).rejects.toMatchObject({
      messageKey: 'member.contactNotFound',
    });
  });

  it('separates "already yours" from "in use elsewhere" when the address is taken', async () => {
    findUserByEmail.mockResolvedValue({ id: 99n });
    findTeamRowByUserId.mockResolvedValue(null);

    await expect(grantContactAccess(7n, context, request)).rejects.toMatchObject({
      messageKey: 'member.teamEmailInUse',
    });
  });
});
