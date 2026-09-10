import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TermStatus, UserStatus } from '@prisma/client';

// `vi.hoisted` because `vi.mock` factories are hoisted above top-level const
// declarations — same pattern as setInitialPassword.linking.test.ts.
const { findUserById } = vi.hoisted(() => ({
  findUserById: vi.fn(),
}));
vi.mock('@modules/auth/auth.repository', () => ({ findUserById }));

// `resolveMemberBenefits` (event.service.ts) reads the member's current term
// straight off the `prisma` singleton and the grace-days setting — both
// mocked here so `me()`'s capability comes out of the SAME rule the pricing
// paths use, not a re-implementation.
const { memberFindFirst } = vi.hoisted(() => ({
  memberFindFirst: vi.fn(),
}));
vi.mock('@db/prisma', () => ({ prisma: { member: { findFirst: memberFindFirst } } }));

const { getNumericSetting } = vi.hoisted(() => ({
  getNumericSetting: vi.fn(),
}));
vi.mock('@helpers/settings', () => ({
  getNumericSetting,
  SETTING_KEYS: { MEMBERSHIP_GRACE_DAYS: 'membership.grace_days' },
}));

import { me } from '@modules/auth/auth.service';

const user = {
  id: 78n,
  email: 'parthik@example.com',
  full_name: 'Parthik',
  phone: null,
  status: UserStatus.ACTIVE,
  email_verified_at: new Date('2026-01-01T00:00:00.000Z'),
  last_login_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  findUserById.mockResolvedValue(user);
  getNumericSetting.mockResolvedValue(30); // DEFAULT_GRACE_DAYS
});

describe('me — capabilities.member_benefits', () => {
  it('is FALSE for a member whose term is PENDING_PAYMENT (invoice not yet paid)', async () => {
    memberFindFirst.mockResolvedValue({
      current_term: {
        status: TermStatus.PENDING_PAYMENT,
        valid_till: new Date('2027-01-01T00:00:00.000Z'),
      },
    });

    const result = await me(78n);

    expect(result.capabilities.member_benefits).toBe(false);
  });

  it('is TRUE for a member whose term is ACTIVE', async () => {
    memberFindFirst.mockResolvedValue({
      current_term: {
        status: TermStatus.ACTIVE,
        valid_till: new Date('2027-01-01T00:00:00.000Z'),
      },
    });

    const result = await me(78n);

    expect(result.capabilities.member_benefits).toBe(true);
  });
});
