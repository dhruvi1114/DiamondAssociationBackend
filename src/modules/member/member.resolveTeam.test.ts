import { describe, expect, it, vi } from 'vitest';

const memberFindFirst = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: { member: { findFirst: (...a: unknown[]) => memberFindFirst(...a) } },
}));

const { findMemberByUserId } = await import('@modules/member/member.repository');
const { MEMBER_USER_STATUS } = await import('@modules/member/team.constants');

const db = { member: { findFirst: memberFindFirst } } as never;

describe('findMemberByUserId', () => {
  it('resolves through MemberUsers, not primary_user_id, so a team login sees the company', async () => {
    memberFindFirst.mockResolvedValue({ id: 1042n });

    const result = await findMemberByUserId(db, 77n);

    expect(result).toEqual({ id: 1042n });

    const where = memberFindFirst.mock.calls[0][0].where;

    expect(where).toMatchObject({
      deletedAt: null,
      team_users: { some: { user_id: 77n, status: MEMBER_USER_STATUS.ACTIVE } },
    });
    expect(where).not.toHaveProperty('primary_user_id');
  });

  it('does not resolve a login that is only INVITED or DEACTIVATED', async () => {
    memberFindFirst.mockResolvedValue(null);

    const result = await findMemberByUserId(db, 78n);

    expect(result).toBeNull();
    expect(memberFindFirst.mock.calls[0][0].where.team_users.some.status).toBe(
      MEMBER_USER_STATUS.ACTIVE,
    );
  });
});
