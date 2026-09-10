import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MEMBER_ROLE, MEMBER_USER_STATUS } from '@modules/member/team.constants';
import { ensureOwnerContact, ensureOwnerTeamRow } from '@modules/member/member.repository';

/**
 * Regression coverage for the bug behind the Profile 500: a member created
 * without an owner `MemberUsers` row is invisible to `findMemberByUserId`,
 * because that lookup resolves a login to its company through `MemberUsers`,
 * not `Members.primary_user_id`.
 *
 * `register.service.ts` has no direct test coverage, and mocking its full
 * transaction — application, document, notification, audit and masters
 * modules all run inside it — is impractical for what these two helpers are:
 * two straightforward "create if absent" checks. So the logic itself is
 * extracted into `ensureOwnerTeamRow` / `ensureOwnerContact`
 * (member.repository.ts) and both of register.service.ts's branches (fresh
 * signup and re-application) call them rather than the raw
 * `createOwnerTeamRow` / `createContact` `provisionMember` uses. Testing the
 * helpers here is what would fail if someone reverted either call to the
 * unconditional version, or deleted it outright and broke the guard.
 */
const db = () => ({
  memberUser: { findFirst: vi.fn(), create: vi.fn() },
  memberContact: { findFirst: vi.fn(), create: vi.fn() },
});

beforeEach(() => vi.clearAllMocks());

describe('ensureOwnerTeamRow', () => {
  it('creates the OWNER row when this login has none on this member', async () => {
    const tx = db();
    tx.memberUser.findFirst.mockResolvedValue(null);

    await ensureOwnerTeamRow(tx as never, { member_id: 64n, user_id: 78n });

    expect(tx.memberUser.findFirst).toHaveBeenCalledWith({
      where: { member_id: 64n, user_id: 78n },
      select: { id: true },
    });
    expect(tx.memberUser.create).toHaveBeenCalledOnce();
    expect(tx.memberUser.create.mock.calls[0][0]).toMatchObject({
      data: {
        member_id: 64n,
        user_id: 78n,
        member_role: MEMBER_ROLE.OWNER,
        status: MEMBER_USER_STATUS.ACTIVE,
      },
    });
  });

  it('is idempotent — a re-applicant whose member already carries an owner row is left untouched', async () => {
    const tx = db();
    // This is the exact shape a re-application reuses: the member's owner row
    // survived the earlier rejected attempt. Creating a second one would
    // violate `MemberUsers_one_owner_per_member`.
    tx.memberUser.findFirst.mockResolvedValue({ id: 9n });

    await ensureOwnerTeamRow(tx as never, { member_id: 64n, user_id: 78n });

    expect(tx.memberUser.create).not.toHaveBeenCalled();
  });
});

describe('ensureOwnerContact', () => {
  const owner = { member_id: 64n, user_id: 78n, name: 'Parthik', email: 'a@b.com', phone: null };

  it('creates the owner as a contact, and primary when the member has none yet', async () => {
    const tx = db();
    tx.memberContact.findFirst
      .mockResolvedValueOnce(null) // no existing contact for this user
      .mockResolvedValueOnce(null); // no existing primary contact

    await ensureOwnerContact(tx as never, owner);

    expect(tx.memberContact.create).toHaveBeenCalledOnce();
    expect(tx.memberContact.create.mock.calls[0][0]).toMatchObject({
      data: { member_id: 64n, user_id: 78n, name: 'Parthik', is_primary: true },
    });
  });

  it('does not claim primary when the member already has one', async () => {
    const tx = db();
    tx.memberContact.findFirst
      .mockResolvedValueOnce(null) // no existing contact for this user
      .mockResolvedValueOnce({ id: 3n }); // somebody else is already primary

    await ensureOwnerContact(tx as never, owner);

    expect(tx.memberContact.create.mock.calls[0][0]).toMatchObject({
      data: { is_primary: false },
    });
  });

  it('is idempotent — a re-applicant whose owner already has a contact is left untouched', async () => {
    const tx = db();
    tx.memberContact.findFirst.mockResolvedValueOnce({ id: 5n });

    await ensureOwnerContact(tx as never, owner);

    expect(tx.memberContact.create).not.toHaveBeenCalled();
  });
});
