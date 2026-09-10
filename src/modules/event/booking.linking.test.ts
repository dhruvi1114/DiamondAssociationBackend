import { describe, expect, it, vi, beforeEach } from 'vitest';
import { UserStatus } from '@prisma/client';
import { logger } from '@logger/logger';

import {
  linkVerifiedGuestBookings,
  memberIdForVerifiedEmail,
} from '@modules/event/booking.linking';

const db = () => ({
  user: { findFirst: vi.fn() },
  member: { findFirst: vi.fn() },
  guestRegistrant: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
});

beforeEach(() => vi.clearAllMocks());

describe('memberIdForVerifiedEmail', () => {
  it('returns the member id for an ACTIVE account with a member record', async () => {
    const tx = db();
    tx.user.findFirst.mockResolvedValue({ id: 7n, status: UserStatus.ACTIVE });
    tx.member.findFirst.mockResolvedValue({ id: 42n });

    await expect(memberIdForVerifiedEmail(tx as never, 'a@b.com')).resolves.toBe(42n);
  });

  it('returns null for a PENDING_APPROVAL applicant — they are not a member yet', async () => {
    const tx = db();
    tx.user.findFirst.mockResolvedValue(null); // the query filters on ACTIVE

    await expect(memberIdForVerifiedEmail(tx as never, 'a@b.com')).resolves.toBeNull();
    expect(tx.member.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when the account has no member record', async () => {
    const tx = db();
    tx.user.findFirst.mockResolvedValue({ id: 7n, status: UserStatus.ACTIVE });
    tx.member.findFirst.mockResolvedValue(null);

    await expect(memberIdForVerifiedEmail(tx as never, 'a@b.com')).resolves.toBeNull();
  });
});

describe('linkVerifiedGuestBookings', () => {
  it('attaches only verified, unlinked rows for that exact email', async () => {
    const tx = db();
    tx.user.findFirst.mockResolvedValue({ id: 7n, email: 'a@b.com', status: UserStatus.ACTIVE });
    tx.member.findFirst.mockResolvedValue({ id: 42n });
    tx.guestRegistrant.updateMany.mockResolvedValue({ count: 2 });

    await expect(linkVerifiedGuestBookings(tx as never, 7n)).resolves.toBe(2);

    expect(tx.guestRegistrant.updateMany).toHaveBeenCalledWith({
      where: {
        email: 'a@b.com',
        email_verified_at: { not: null },
        linked_member_id: null,
      },
      data: { linked_member_id: 42n },
    });
  });

  it('is idempotent — a second run attaches nothing because the guard excludes linked rows', async () => {
    const tx = db();
    tx.user.findFirst.mockResolvedValue({ id: 7n, email: 'a@b.com', status: UserStatus.ACTIVE });
    tx.member.findFirst.mockResolvedValue({ id: 42n });
    tx.guestRegistrant.updateMany.mockResolvedValue({ count: 0 });

    await expect(linkVerifiedGuestBookings(tx as never, 7n)).resolves.toBe(0);
  });

  it('does nothing when the user owns no member record', async () => {
    const tx = db();
    tx.user.findFirst.mockResolvedValue({ id: 7n, email: 'a@b.com', status: UserStatus.ACTIVE });
    tx.member.findFirst.mockResolvedValue(null);

    await expect(linkVerifiedGuestBookings(tx as never, 7n)).resolves.toBe(0);
    expect(tx.guestRegistrant.updateMany).not.toHaveBeenCalled();
  });

  it('logs the skip — distinguishably from "nothing to link" — for a team login that is not the primary user', async () => {
    const tx = db();
    tx.user.findFirst.mockResolvedValue({ id: 7n, email: 'a@b.com', status: UserStatus.ACTIVE });
    tx.member.findFirst.mockResolvedValue(null); // this login is not any Member.primary_user_id
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    await expect(linkVerifiedGuestBookings(tx as never, 7n)).resolves.toBe(0);

    expect(infoSpy).toHaveBeenCalledWith('event.guestBookingLinkSkipped', {
      userId: '7',
      reason: 'not_primary_user',
    });
    // The address must never reach the log stream (observability.md §3).
    expect(infoSpy.mock.calls[0][1]).not.toHaveProperty('email');

    infoSpy.mockRestore();
  });
});
