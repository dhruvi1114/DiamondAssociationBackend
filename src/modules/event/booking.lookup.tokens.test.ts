import { describe, expect, it } from 'vitest';
import {
  signBookingLookupToken,
  verifyBookingLookupToken,
} from '@modules/event/booking.lookup.tokens';

describe('booking lookup token', () => {
  it('round-trips the email it was issued for', () => {
    const token = signBookingLookupToken('a@b.com');
    expect(verifyBookingLookupToken(token)).toBe('a@b.com');
  });

  it('refuses a token that is not one of ours', () => {
    expect(() => verifyBookingLookupToken('not.a.token')).toThrow();
  });

  it('refuses a member access token — the scopes must not be interchangeable', async () => {
    const { signMemberAccessToken } = await import('@utils/jwt');
    const memberToken = signMemberAccessToken({ userId: 1n, status: 'ACTIVE' as never });

    expect(() => verifyBookingLookupToken(memberToken)).toThrow();
  });
});
