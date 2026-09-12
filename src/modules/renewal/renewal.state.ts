import type { MemberStatus, TermStatus } from '@prisma/client';
import { daysBetween } from '@modules/renewal/renewal.dates';

/** Days before the current term ends at which a reminder is due (decided 2026-09-10). */
export const REMINDER_STAGES = [0, 3, 7, 15] as const;
export type ReminderCode = 'T-15' | 'T-7' | 'T-3' | 'T-0';

/**
 * The stage today falls in: the smallest stage at or above the days left. A stage missed
 * because the invoice was raised late is skipped, never sent in a burst — the member gets
 * today's message once, not three messages in one morning.
 */
export const reminderStageFor = (daysLeft: number): ReminderCode | null => {
  if (daysLeft < 0) return null;
  const stage = REMINDER_STAGES.find((s) => s >= daysLeft);
  return stage === undefined ? null : (`T-${stage}` as ReminderCode);
};

export const headlineFor = (code: ReminderCode, expiresOn: string): string => {
  switch (code) {
    case 'T-15':
      return `Your membership renews on ${expiresOn} — your renewal invoice is ready`;
    case 'T-7':
      return `7 days left — your membership ends on ${expiresOn}`;
    case 'T-3':
      return `3 days left — your membership ends on ${expiresOn}`;
    case 'T-0':
      return 'Your membership ends today';
  }
};

export type TermState =
  | 'NONE'
  | 'INACTIVE'
  | 'AWAITING_FIRST_PAYMENT'
  | 'ACTIVE'
  | 'EXPIRING_SOON'
  | 'RENEWED'
  | 'IN_GRACE'
  | 'EXPIRED'
  | 'DECLINED';

/**
 * Where a member stands, decided once on the server so the banner, the membership page and any
 * later email all say the same thing (business logic belongs in the backend).
 */
export const termState = (input: {
  memberStatus: MemberStatus;
  current: { status: TermStatus; valid_till: Date } | null;
  renewalStatus: TermStatus | null;
  today: Date;
  noticeDays: number;
  declined: boolean;
}): TermState => {
  const { memberStatus, current, renewalStatus, today, noticeDays, declined } = input;

  if (memberStatus === 'SUSPENDED' || memberStatus === 'TERMINATED') return 'INACTIVE';
  if (!current || current.status === 'CANCELLED') return 'NONE';
  if (current.status === 'PENDING_PAYMENT') return 'AWAITING_FIRST_PAYMENT';
  if (renewalStatus === 'PAID_UPCOMING') return 'RENEWED';
  if (memberStatus === 'EXPIRED') return 'EXPIRED';
  if (declined) return 'DECLINED';

  const daysLeft = daysBetween(today, current.valid_till);
  if (daysLeft < 0) return 'IN_GRACE';
  if (daysLeft <= noticeDays) return 'EXPIRING_SOON';
  return 'ACTIVE';
};
