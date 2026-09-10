import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OtpPurpose } from '@prisma/client';

const { getBooleanSetting } = vi.hoisted(() => ({ getBooleanSetting: vi.fn() }));
vi.mock('@helpers/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@helpers/settings')>()),
  getBooleanSetting,
}));

const { consumeBookingOtp } = vi.hoisted(() => ({ consumeBookingOtp: vi.fn() }));
vi.mock('@modules/event/booking.otp', () => ({
  consumeBookingOtp,
  issueBookingOtp: vi.fn(),
  BOOKING_OTP_TEMPLATE: 'event.booking_otp',
  LOOKUP_OTP_TEMPLATE: 'event.booking_lookup_otp',
}));

import { verifyGuestEmail } from '@modules/event/registration.service';

beforeEach(() => vi.clearAllMocks());

describe('verifyGuestEmail', () => {
  it('does nothing at all when the flag is off — this is the "nothing broke" case', async () => {
    getBooleanSetting.mockResolvedValue(false);

    await expect(verifyGuestEmail({} as never, 'a@b.com', undefined)).resolves.toBeNull();

    expect(consumeBookingOtp).not.toHaveBeenCalled();
  });

  it('ignores a code that was sent while the flag is off', async () => {
    getBooleanSetting.mockResolvedValue(false);

    await expect(verifyGuestEmail({} as never, 'a@b.com', '123456')).resolves.toBeNull();
    expect(consumeBookingOtp).not.toHaveBeenCalled();
  });

  it('refuses a booking with no code when the flag is on', async () => {
    getBooleanSetting.mockResolvedValue(true);

    await expect(verifyGuestEmail({} as never, 'a@b.com', undefined)).rejects.toThrow();
    expect(consumeBookingOtp).not.toHaveBeenCalled();
  });

  it('consumes the code and returns a verification instant when the flag is on', async () => {
    getBooleanSetting.mockResolvedValue(true);
    consumeBookingOtp.mockResolvedValue(undefined);

    const at = await verifyGuestEmail({} as never, 'a@b.com', '123456');

    expect(at).toBeInstanceOf(Date);
    expect(consumeBookingOtp).toHaveBeenCalledWith(
      expect.anything(),
      'a@b.com',
      OtpPurpose.GUEST_BOOKING_VERIFY,
      '123456',
    );
  });

  it('propagates a bad code as a failure, so the booking rolls back', async () => {
    getBooleanSetting.mockResolvedValue(true);
    consumeBookingOtp.mockRejectedValue(new Error('bad code'));

    await expect(verifyGuestEmail({} as never, 'a@b.com', '000000')).rejects.toThrow();
  });
});
