import { describe, expect, it, vi } from 'vitest';

vi.mock('@db/prisma', () => ({ prisma: {} }));

const { resolveBookingContact } = await import('@modules/event/registration.service');

/**
 * Where correspondence about a booking goes.
 *
 * Every notice the event module sends is addressed to `contact_email`: pending
 * payment, the hold reminders, payment verified, cancellation. Left null they
 * were queued with no recipient and failed with "EMAIL notification has no
 * to_address" — silently, because the in-app copy of the same notice went out
 * fine and nothing on screen said the email had not. That is what these pin down.
 */
const login = { email: 'owner@firm.test', phone: '9876543210', full_name: 'Kajal' };

describe('a booking’s contact address', () => {
  it('falls back to the login that made the booking when none was nominated', () => {
    expect(resolveBookingContact({}, login).email).toBe('owner@firm.test');
  });

  it('prefers an address the booking form nominated', () => {
    // A firm that wants event mail at its accounts inbox, not the booker's.
    expect(resolveBookingContact({ contact_email: 'accounts@firm.test' }, login).email).toBe(
      'accounts@firm.test',
    );
  });

  it('never invents one when there is no login and none was given', () => {
    // Inventing one would send a member's booking details to whoever owns it.
    expect(resolveBookingContact({}, null).email).toBeNull();
  });

  it('resolves name and phone the same way, so all three agree', () => {
    const resolved = resolveBookingContact({ contact_phone: '9000000000' }, login);

    expect(resolved.name).toBe('Kajal');
    expect(resolved.phone).toBe('9000000000');
    expect(resolved.email).toBe('owner@firm.test');
  });

  it('does not treat a login with no address on file as an address', () => {
    const empty = { email: null, phone: null, full_name: null };

    expect(resolveBookingContact({}, empty)).toEqual({ name: null, email: null, phone: null });
  });
});
