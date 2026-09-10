import { describe, expect, it } from 'vitest';
import { EDITABLE_SETTINGS } from '@modules/settings/settings.types';
import { SETTING_KEYS } from '@helpers/settings';

describe('guest booking feature flags', () => {
  it('exposes both keys on SETTING_KEYS', () => {
    expect(SETTING_KEYS.GUEST_BOOKING_OTP).toBe('events.guest_booking_otp');
    expect(SETTING_KEYS.BOOKING_LOOKUP_ENABLED).toBe('events.booking_lookup_enabled');
  });

  it('makes both editable through the settings API', () => {
    expect(EDITABLE_SETTINGS['events.guest_booking_otp']).toBeDefined();
    expect(EDITABLE_SETTINGS['events.booking_lookup_enabled']).toBeDefined();
  });

  it('accepts only "true" or "false" for each', () => {
    for (const key of ['events.guest_booking_otp', 'events.booking_lookup_enabled']) {
      const rule = EDITABLE_SETTINGS[key]!;
      expect(rule.safeParse('true').success).toBe(true);
      expect(rule.safeParse('false').success).toBe(true);
      expect(rule.safeParse('yes').success).toBe(false);
      expect(rule.safeParse('').success).toBe(false);
    }
  });
});
