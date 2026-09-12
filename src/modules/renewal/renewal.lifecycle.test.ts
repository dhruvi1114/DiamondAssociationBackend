import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const dueCandidates = vi.fn();
const reminderCandidates = vi.fn();
const claimReminder = vi.fn();
const raiseRenewal = vi.fn();
const notifyMember = vi.fn();

vi.mock('@modules/renewal/renewal.repository', () => ({
  dueCandidates: (...a: unknown[]) => dueCandidates(...a),
  reminderCandidates: (...a: unknown[]) => reminderCandidates(...a),
  claimReminder: (...a: unknown[]) => claimReminder(...a),
}));
vi.mock('@modules/renewal/renewal.raise', () => ({
  raiseRenewal: (...a: unknown[]) => raiseRenewal(...a),
}));
vi.mock('@modules/renewal/renewal.notify', () => ({
  notifyMember: (...a: unknown[]) => notifyMember(...a),
}));
vi.mock('@db/prisma', () => ({
  prisma: { $transaction: (fn: (tx: unknown) => unknown) => fn({}) },
}));

const { raiseDueRenewals, sendRenewalReminders } =
  await import('@modules/renewal/renewal.lifecycle');

const CFG = { noticeDays: 15, basis: 'term' as const, dueDays: 15 };
const cand = (over = {}) => ({
  term_id: 1n,
  member_id: 5n,
  category_id: 2n,
  tier_id: null,
  fee_plan_id: 7n,
  valid_till: day('2027-09-11'),
  member_code: 'LGDGF/2026/0042',
  company_name: 'Sunrise Foods',
  ...over,
});

describe('raiseDueRenewals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('raises each candidate and reports skips by company', async () => {
    dueCandidates.mockResolvedValue([
      cand(),
      cand({ member_id: 6n, company_name: 'Shreeji Exports', fee_plan_id: null }),
    ]);
    raiseRenewal
      .mockResolvedValueOnce({
        outcome: 'RAISED',
        termId: 9n,
        invoiceId: 10n,
        invoiceNumber: 'IN1',
        total: '23600.00',
      })
      .mockResolvedValueOnce({ outcome: 'SKIPPED', reason: 'NO_PLAN' });

    const result = await raiseDueRenewals(day('2027-08-27'), CFG);

    expect(dueCandidates).toHaveBeenCalledWith(expect.anything(), day('2027-09-11'));
    expect(result.raised).toBe(1);
    expect(result.skipped).toEqual([
      { member_code: 'LGDGF/2026/0042', company_name: 'Shreeji Exports', reason: 'NO_PLAN' },
    ]);
  });

  it('treats a unique-violation race as already raised, not a failure', async () => {
    dueCandidates.mockResolvedValue([cand()]);
    raiseRenewal.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    const result = await raiseDueRenewals(day('2027-08-27'), CFG);
    expect(result.raised).toBe(0);
    expect(result.skipped[0].reason).toBe('ALREADY_RAISED');
  });
});

describe('sendRenewalReminders', () => {
  beforeEach(() => vi.clearAllMocks());

  const rem = (validFrom: string) => ({
    term_id: 9n,
    member_id: 5n,
    valid_from: day(validFrom),
    invoice_number: 'IN1',
    total_amount: new Prisma.Decimal('23600'),
    currency: 'INR',
    due_date: day('2027-09-11'),
    plan_name: 'Best Value',
  });

  it('sends the stage for today once', async () => {
    reminderCandidates.mockResolvedValue([rem('2027-09-12')]); // ends 11 Sep, today 4 Sep → 7 days
    claimReminder.mockResolvedValue(1);
    notifyMember.mockResolvedValue(1);
    await expect(sendRenewalReminders(day('2027-09-04'))).resolves.toBe(1);
    expect(claimReminder).toHaveBeenCalledWith(expect.anything(), 9n, 'T-7', day('2027-09-04'));
    expect(notifyMember).toHaveBeenCalledWith(
      expect.anything(),
      5n,
      'membership.renewal_reminder',
      expect.objectContaining({ invoice_number: 'IN1', expires_on: '2027-09-11' }),
    );
  });

  it('sends nothing when the stage was already sent', async () => {
    reminderCandidates.mockResolvedValue([rem('2027-09-12')]);
    claimReminder.mockResolvedValue(0);
    await expect(sendRenewalReminders(day('2027-09-04'))).resolves.toBe(0);
    expect(notifyMember).not.toHaveBeenCalled();
  });
});
