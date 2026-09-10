import { describe, expect, it, vi, beforeEach } from 'vitest';
import { UserStatus } from '@prisma/client';

// `vi.hoisted` because `vi.mock` factories are hoisted above top-level const
// declarations — referencing a plain top-level const inside a factory throws
// "Cannot access before initialization". Same pattern as booking.otp.test.ts.
const { linkVerifiedGuestBookings } = vi.hoisted(() => ({
  linkVerifiedGuestBookings: vi.fn(),
}));
vi.mock('@modules/event/booking.linking', () => ({
  linkVerifiedGuestBookings,
  memberIdForVerifiedEmail: vi.fn(),
}));

const { loggerError } = vi.hoisted(() => ({
  loggerError: vi.fn(),
}));
vi.mock('@logger/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: loggerError, debug: vi.fn() },
}));

// The module-level `prisma` singleton, mocked so `setInitialPassword`'s
// `$transaction` genuinely invokes its callback (against a fake `tx`) instead
// of opening a real database connection. Same shape as booking.otp.test.ts.
const { prismaMock, txMock } = vi.hoisted(() => {
  const txMock = {};
  return {
    txMock,
    prismaMock: {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txMock)),
    },
  };
});
vi.mock('@db/prisma', () => ({ prisma: prismaMock }));

// Only the four repo functions `setInitialPassword` itself calls need a body;
// every other export of this module is untouched by the test below.
const repoMocks = vi.hoisted(() => ({
  findPasswordResetByHash: vi.fn(),
  findUserCredentialById: vi.fn(),
  consumePasswordResetToken: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock('@modules/auth/auth.repository', () => repoMocks);

const { activateInvitedTeamRow } = vi.hoisted(() => ({
  activateInvitedTeamRow: vi.fn(),
}));
vi.mock('@modules/member/team.activation', () => ({ activateInvitedTeamRow }));

const { writeAudit } = vi.hoisted(() => ({
  writeAudit: vi.fn(),
}));
vi.mock('@helpers/audit', () => ({ writeAudit }));

import { attachBookingsAfterActivation, setInitialPassword } from '@modules/auth/auth.service';

beforeEach(() => vi.clearAllMocks());

describe('attachBookingsAfterActivation', () => {
  it('attaches bookings for the newly active member', async () => {
    linkVerifiedGuestBookings.mockResolvedValue(3);

    await expect(attachBookingsAfterActivation(7n)).resolves.toBeUndefined();

    expect(linkVerifiedGuestBookings).toHaveBeenCalledWith(expect.anything(), 7n);
  });

  it('swallows a failure — the password is already set and must stand', async () => {
    linkVerifiedGuestBookings.mockRejectedValue(new Error('database is on fire'));

    await expect(attachBookingsAfterActivation(7n)).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalled();
  });
});

describe('setInitialPassword — the atomicity boundary itself', () => {
  // This is the regression test for "the single most important rule of this
  // task": linking must never be able to roll back the password write.
  // `attachBookingsAfterActivation`'s own tests above only prove that function
  // swallows errors in isolation — they say nothing about where the call sits
  // relative to `prisma.$transaction` inside `setInitialPassword`, and
  // `grep -rl "setInitialPassword" src --include="*.test.ts"` found no other
  // test that exercises `setInitialPassword` itself.
  //
  // IMPORTANT — this is NOT a simple "does the promise still resolve" check.
  // I tried that first (mock `linkVerifiedGuestBookings` to reject, assert
  // `setInitialPassword(...)` resolves) and empirically moved the real call
  // inside the transaction to see it fail — it didn't. `resolves` stayed
  // green even with the call inside `$transaction`, because
  // `attachBookingsAfterActivation` has its own try/catch: it never rethrows,
  // so wherever the *wrapped* call sits, `setInitialPassword`'s promise
  // resolves either way. A "still resolves" assertion is not a discriminator
  // here — it passes on both the correct code and the regression, which is
  // exactly the "test that cannot fail" trap.
  //
  // The actual structural property that changes when the call moves inside
  // is CALL ORDER: linking must be attempted strictly after the `$transaction`
  // callback has run to completion (i.e. after commit), never during it. So
  // this test tracks the order `$transaction`'s callback settles vs. when
  // `linkVerifiedGuestBookings` is invoked, and asserts commit-before-link.
  // Verified by temporarily moving `await attachBookingsAfterActivation(user.id)`
  // back inside the `prisma.$transaction` callback in auth.service.ts: this
  // specific assertion (the `toEqual(['transaction:committed', 'linking:called'])`
  // one below) failed with the order reversed, while a plain "resolves"
  // assertion stayed green throughout — confirming order, not resolution, is
  // the real discriminator. Reverted before this file was left in place.
  it('attempts linking only after the transaction has committed, and the password write survives a linking failure', async () => {
    const callOrder: string[] = [];

    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const result = await callback(txMock);
        callOrder.push('transaction:committed');
        return result;
      },
    );
    linkVerifiedGuestBookings.mockImplementation(async () => {
      callOrder.push('linking:called');
      throw new Error('database is on fire');
    });

    repoMocks.findPasswordResetByHash.mockResolvedValue({
      id: 1n,
      user_id: 7n,
      admin_user_id: null,
      expires_at: new Date(Date.now() + 60_000),
      used_at: null,
    });
    repoMocks.findUserCredentialById.mockResolvedValue({
      id: 7n,
      status: UserStatus.PENDING_VERIFICATION,
      password_hash: null,
    });
    repoMocks.consumePasswordResetToken.mockResolvedValue({});
    repoMocks.updateUser.mockResolvedValue({ id: 7n });
    activateInvitedTeamRow.mockResolvedValue(undefined);
    writeAudit.mockResolvedValue(undefined);

    await expect(
      setInitialPassword(
        { token: 'a-valid-token', password: 'Sup3r-Secret!' },
        { ip: null, userAgent: null, requestId: null },
      ),
    ).resolves.toBeUndefined();

    // The commit happened before linking was even attempted — this is what
    // "outside the transaction" means operationally, and it fails (order
    // reversed) if the call is moved back inside `$transaction`.
    expect(callOrder).toEqual(['transaction:committed', 'linking:called']);

    // The password write itself went through, on the real `tx`, regardless
    // of the linking failure.
    expect(repoMocks.updateUser).toHaveBeenCalledWith(
      txMock,
      7n,
      expect.objectContaining({ status: UserStatus.ACTIVE }),
    );
  });
});
