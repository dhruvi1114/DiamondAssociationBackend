import { describe, expect, it } from 'vitest';
import {
  headlineFor,
  reminderStageFor,
  termState,
  type ReminderCode,
} from '@modules/renewal/renewal.state';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const base = { today: day('2027-03-20'), noticeDays: 15, declined: false };

describe('reminderStageFor', () => {
  it.each([
    [15, 'T-15'],
    [10, 'T-15'],
    [8, 'T-15'],
    [7, 'T-7'],
    [4, 'T-7'],
    [3, 'T-3'],
    [1, 'T-3'],
    [0, 'T-0'],
    [16, null],
    [-1, null],
  ])('%i days left → %s', (daysLeft, code) => {
    expect(reminderStageFor(daysLeft)).toBe(code);
  });
});

describe('headlineFor', () => {
  const expiresOn = '2027-03-31';

  it.each<[ReminderCode, string]>([
    ['T-15', 'Your membership renews on 2027-03-31 — your renewal invoice is ready'],
    ['T-7', '7 days left — your membership ends on 2027-03-31'],
    ['T-3', '3 days left — your membership ends on 2027-03-31'],
    ['T-0', 'Your membership ends today'],
  ])('%s → %s', (code, headline) => {
    expect(headlineFor(code, expiresOn)).toBe(headline);
  });
});

describe('termState', () => {
  const current = (till: string) => ({ status: 'ACTIVE' as const, valid_till: day(till) });

  it('is ACTIVE outside the notice window', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'ACTIVE',
        current: current('2027-09-11'),
        renewalStatus: null,
      }),
    ).toBe('ACTIVE');
  });
  it('is EXPIRING_SOON inside the notice window', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'ACTIVE',
        current: current('2027-03-31'),
        renewalStatus: 'PENDING_PAYMENT',
      }),
    ).toBe('EXPIRING_SOON');
  });
  it('is RENEWED once the renewal is paid ahead', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'ACTIVE',
        current: current('2027-03-31'),
        renewalStatus: 'PAID_UPCOMING',
      }),
    ).toBe('RENEWED');
  });
  it('is IN_GRACE after the term ended while the member is still ACTIVE', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'ACTIVE',
        current: { status: 'EXPIRED', valid_till: day('2027-03-10') },
        renewalStatus: 'PENDING_PAYMENT',
      }),
    ).toBe('IN_GRACE');
  });
  it('is EXPIRED when the member is EXPIRED', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'EXPIRED',
        current: { status: 'EXPIRED', valid_till: day('2027-01-31') },
        renewalStatus: 'PENDING_PAYMENT',
      }),
    ).toBe('EXPIRED');
  });
  it('is AWAITING_FIRST_PAYMENT for an unpaid first term', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'PENDING',
        current: { status: 'PENDING_PAYMENT', valid_till: day('2028-03-19') },
        renewalStatus: null,
      }),
    ).toBe('AWAITING_FIRST_PAYMENT');
  });
  it('is INACTIVE for suspended or terminated members', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'SUSPENDED',
        current: current('2027-09-11'),
        renewalStatus: null,
      }),
    ).toBe('INACTIVE');
  });
  it('is NONE with no term', () => {
    expect(termState({ ...base, memberStatus: 'DRAFT', current: null, renewalStatus: null })).toBe(
      'NONE',
    );
  });
  it('is NONE when the current term was cancelled', () => {
    expect(
      termState({
        ...base,
        memberStatus: 'ACTIVE',
        current: { status: 'CANCELLED', valid_till: day('2027-09-11') },
        renewalStatus: null,
      }),
    ).toBe('NONE');
  });
  it('is DECLINED when the member said no and has not yet expired', () => {
    expect(
      termState({
        ...base,
        declined: true,
        memberStatus: 'ACTIVE',
        current: current('2027-03-31'),
        renewalStatus: null,
      }),
    ).toBe('DECLINED');
  });
  it('is EXPIRED, not DECLINED, once grace has passed', () => {
    expect(
      termState({
        ...base,
        declined: true,
        memberStatus: 'EXPIRED',
        current: { status: 'EXPIRED', valid_till: day('2027-01-31') },
        renewalStatus: null,
      }),
    ).toBe('EXPIRED');
  });
});
