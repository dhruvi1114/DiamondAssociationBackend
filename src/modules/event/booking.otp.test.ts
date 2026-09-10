import { describe, expect, it, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { OtpPurpose } from '@prisma/client';

vi.mock('@notifications/outbox', () => ({ queueNotification: vi.fn() }));

// The module-level `prisma` singleton, mocked separately from any `db`/`tx`
// a test passes in. FAILURE bookkeeping in `consumeBookingOtp` (attempt-count
// increment, both `consumed_at` retirements) is written through this singleton
// on purpose, so it survives the caller's transaction rolling back on the same
// throw. `vi.hoisted` because `vi.mock` factories are hoisted above top-level
// `const`s — a bare `const prismaMock = {...}` referenced from the factory
// below would be a TDZ error at import time.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: { otpCode: { update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock('@db/prisma', () => ({ prisma: prismaMock }));

import { consumeBookingOtp, issueBookingOtp } from '@modules/event/booking.otp';
import { queueNotification } from '@notifications/outbox';

const live = (code: string, overrides: Record<string, unknown> = {}) => ({
  id: 1n,
  code_hash: bcrypt.hashSync(code, 4),
  expires_at: new Date(Date.now() + 600_000),
  attempt_count: 0,
  ...overrides,
});

const db = () => ({
  otpCode: {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: 1n }),
    findFirst: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
});

beforeEach(() => vi.clearAllMocks());

describe('issueBookingOtp', () => {
  it('retires any live code for the same email and purpose before issuing', async () => {
    const tx = db();
    await issueBookingOtp(tx as never, 'a@b.com', OtpPurpose.GUEST_BOOKING_VERIFY);

    expect(tx.otpCode.updateMany).toHaveBeenCalledOnce();
    expect(tx.otpCode.create).toHaveBeenCalledOnce();
    expect(queueNotification).toHaveBeenCalledOnce();
  });

  it('never puts the plaintext code in the stored row', async () => {
    const tx = db();
    await issueBookingOtp(tx as never, 'a@b.com', OtpPurpose.GUEST_BOOKING_VERIFY);

    const stored = tx.otpCode.create.mock.calls[0][0].data;
    const sent = (queueNotification as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].payload
      .otp;

    expect(stored.code_hash).not.toBe(sent);
    expect(await bcrypt.compare(sent, stored.code_hash)).toBe(true);
  });
});

describe('consumeBookingOtp', () => {
  it("accepts the right code and consumes it through the CALLER's db, not the singleton", async () => {
    const tx = db();
    tx.otpCode.findFirst.mockResolvedValue(live('123456'));

    await expect(
      consumeBookingOtp(tx as never, 'a@b.com', OtpPurpose.GUEST_BOOKING_VERIFY, '123456'),
    ).resolves.toBeUndefined();

    // Success has to roll back with the booking, so it is written on the `tx`
    // the caller passed in — never on the module-level singleton.
    expect(tx.otpCode.update).toHaveBeenCalledOnce();
    expect(tx.otpCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { consumed_at: expect.any(Date) } }),
    );
    expect(prismaMock.otpCode.update).not.toHaveBeenCalled();
  });

  it("rejects a wrong code and counts the attempt through the SINGLETON, not the caller's tx", async () => {
    const tx = db();
    tx.otpCode.findFirst.mockResolvedValue(live('123456'));

    await expect(
      consumeBookingOtp(tx as never, 'a@b.com', OtpPurpose.GUEST_BOOKING_VERIFY, '999999'),
    ).rejects.toThrow();

    // The penalty must stick even if the caller's own transaction (e.g. the
    // booking transaction) throws on this same rejection and rolls back —
    // so it is charged through `prisma`, never through the passed `tx`.
    expect(prismaMock.otpCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempt_count: 1 } }),
    );
    expect(tx.otpCode.update).not.toHaveBeenCalled();
  });

  it('rejects when no code was ever issued', async () => {
    const tx = db();
    tx.otpCode.findFirst.mockResolvedValue(null);

    await expect(
      consumeBookingOtp(tx as never, 'a@b.com', OtpPurpose.GUEST_BOOKING_VERIFY, '123456'),
    ).rejects.toThrow();
  });

  it("rejects an expired code and retires it through the SINGLETON, not the caller's tx", async () => {
    const tx = db();
    tx.otpCode.findFirst.mockResolvedValue(
      live('123456', { expires_at: new Date(Date.now() - 1000) }),
    );

    await expect(
      consumeBookingOtp(tx as never, 'a@b.com', OtpPurpose.GUEST_BOOKING_VERIFY, '123456'),
    ).rejects.toThrow();

    // Same reasoning as the wrong-code case: retiring an expired code is
    // failure bookkeeping, so it must survive the caller's rollback.
    expect(prismaMock.otpCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consumed_at: expect.any(Date) }) }),
    );
    expect(tx.otpCode.update).not.toHaveBeenCalled();
  });

  it('retires the code once the attempt ceiling is reached, through the singleton', async () => {
    const tx = db();
    tx.otpCode.findFirst.mockResolvedValue(live('123456', { attempt_count: 5 }));

    await expect(
      consumeBookingOtp(tx as never, 'a@b.com', OtpPurpose.GUEST_BOOKING_VERIFY, '123456'),
    ).rejects.toThrow();

    expect(prismaMock.otpCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ consumed_at: expect.any(Date) }) }),
    );
    expect(tx.otpCode.update).not.toHaveBeenCalled();
  });
});
