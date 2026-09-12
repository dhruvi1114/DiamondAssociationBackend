import { describe, expect, it, vi } from 'vitest';

import {
  claimReminder,
  dueCandidates,
  reminderCandidates,
} from '@modules/renewal/renewal.repository';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * `Prisma.sql` binds a plain JS `Date` as `timestamptz`, and `timestamptz::date` then depends on
 * the database session's timezone — under a negative-offset session a UTC-midnight date can cast
 * back a day early. Binding the calendar day as ISO text instead (`isoDay(date)`) sidesteps the
 * session timezone entirely: `'2027-09-11'::date` always means 11 Sep. These tests inspect the
 * `Prisma.Sql` object's bound `values` directly, so a regression back to a raw `Date` fails loudly
 * rather than only under a specific server timezone.
 */
describe('renewal.repository date binding', () => {
  it('dueCandidates binds the horizon as an ISO date string, not a Date', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([]);
    const db = { $queryRaw } as unknown as Parameters<typeof dueCandidates>[0];

    await dueCandidates(db, day('2027-09-11'));

    const sql = $queryRaw.mock.calls[0][0];
    expect(sql.values).toContain('2027-09-11');
    expect(sql.values.some((v: unknown) => v instanceof Date)).toBe(false);
  });

  it('reminderCandidates binds today as an ISO date string on both occurrences, not a Date', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([]);
    const db = { $queryRaw } as unknown as Parameters<typeof reminderCandidates>[0];

    await reminderCandidates(db, day('2027-09-04'));

    const sql = $queryRaw.mock.calls[0][0];
    const todayOccurrences = sql.values.filter((v: unknown) => v === '2027-09-04');
    expect(todayOccurrences).toHaveLength(2);
    expect(sql.values.some((v: unknown) => v instanceof Date)).toBe(false);
  });

  it('claimReminder binds sent_on as an ISO date string, not a Date', async () => {
    const $executeRaw = vi.fn().mockResolvedValue(1);
    const db = { $executeRaw } as unknown as Parameters<typeof claimReminder>[0];

    await claimReminder(db, 9n, 'T-7', day('2027-09-04'));

    const sql = $executeRaw.mock.calls[0][0];
    expect(sql.values).toContain('2027-09-04');
    expect(sql.values.some((v: unknown) => v instanceof Date)).toBe(false);
  });
});
