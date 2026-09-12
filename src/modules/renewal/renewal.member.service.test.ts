import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const memberFindFirst = vi.fn();
const termFindFirst = vi.fn();
const termUpdate = vi.fn();
const invoiceUpdate = vi.fn();
const executeRaw = vi.fn();
const loadLivePlan = vi.fn();
const raiseRenewal = vi.fn();

const tx = {
  $executeRaw: executeRaw,
  member: { findFirst: memberFindFirst },
  membershipTerm: { findFirst: termFindFirst, update: termUpdate },
  invoice: { update: invoiceUpdate },
};

vi.mock('@db/prisma', () => ({
  prisma: { ...tx, $transaction: (fn: (t: unknown) => unknown) => fn(tx) },
}));
vi.mock('@helpers/settings', async (orig) => ({
  ...(await orig<typeof import('@helpers/settings')>()),
  getSetting: vi.fn(async () => 'term'),
  getNumericSetting: vi.fn(async (_k: string, fallback: number) => fallback),
}));
vi.mock('@helpers/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('@modules/renewal/renewal.pricing', async (orig) => ({
  ...(await orig<typeof import('@modules/renewal/renewal.pricing')>()),
  loadLivePlan: (...a: unknown[]) => loadLivePlan(...a),
}));
vi.mock('@modules/renewal/renewal.raise', () => ({
  raiseRenewal: (...a: unknown[]) => raiseRenewal(...a),
}));

const service = await import('@modules/renewal/renewal.member.service');

// getMyTermView is called at the end of a successful switch. An ESM spy cannot intercept the
// internal self-call `switchRenewalPlan` makes to it, so instead of spying we let the real
// implementation run and feed it a second, full-shape `member.findFirst` resolution below
// (ruling: see task-11-brief.md step 1 note). Its own behaviour is covered by termState
// (Task 4) and the Sentinel suite.
const AUDIT = { actorId: 3n, ip: null, userAgent: null, requestId: null };
const CURRENT = { valid_till: day('2027-03-31'), category_id: 2n, tier_id: null };
const FULL_MEMBER = {
  status: 'ACTIVE',
  current_term: {
    id: 21n,
    term_type: 'RENEWAL',
    status: 'ACTIVE',
    valid_from: day('2026-04-01'),
    valid_till: day('2027-03-31'),
    fee_plan: null,
  },
};
const pending = (over: Record<string, unknown> = {}) => ({
  id: 20n,
  status: 'PENDING_PAYMENT',
  valid_from: day('2027-04-01'),
  fee_plan_id: 7n,
  invoice: { id: 30n, status: 'ISSUED', paymentSubmissions: [] },
  ...over,
});
const PLAN_8 = {
  id: 8n,
  billing_cycle: 'MONTHLY',
  name: 'Starter',
  renewal_amount: new Prisma.Decimal('2500'),
  tax_rate: new Prisma.Decimal('18'),
  currency: 'INR',
  effective_from: day('2026-04-01'),
  effective_to: null,
  is_active: true,
  price_scope: 'ALL_MEMBERS',
};

const run = () => service.switchRenewalPlan(5n, 8n, AUDIT);

describe('switchRenewalPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // First call is the in-transaction read (`tx.member.findFirst`). A second call only
    // happens on a successful switch, when `getMyTermView` re-reads the member — queued only
    // by the success test below, since the refusal tests never reach it.
    memberFindFirst.mockResolvedValueOnce({ current_term: CURRENT });
    termFindFirst.mockResolvedValue(pending());
    loadLivePlan.mockResolvedValue(PLAN_8);
    raiseRenewal.mockResolvedValue({
      outcome: 'RAISED',
      termId: 21n,
      invoiceId: 31n,
      invoiceNumber: 'IN2',
      total: '2950.00',
    });
  });

  it('404s when no renewal is waiting', async () => {
    termFindFirst.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ messageKey: 'renewal.noPendingRenewal' });
  });

  it('refuses while a payment claim is being checked', async () => {
    termFindFirst.mockResolvedValue(
      pending({ invoice: { id: 30n, status: 'ISSUED', paymentSubmissions: [{ id: 1n }] } }),
    );
    await expect(run()).rejects.toMatchObject({ messageKey: 'renewal.claimPending' });
    expect(invoiceUpdate).not.toHaveBeenCalled();
  });

  it('refuses a plan that is not on sale', async () => {
    loadLivePlan.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ messageKey: 'renewal.planNotAvailable' });
  });

  it('refuses the same plan', async () => {
    termFindFirst.mockResolvedValue(pending({ fee_plan_id: 8n }));
    await expect(run()).rejects.toMatchObject({ messageKey: 'renewal.samePlan' });
  });

  it('cancels the old invoice and term, then raises on the chosen plan from the same start date', async () => {
    memberFindFirst.mockResolvedValueOnce(FULL_MEMBER);
    // Second call is `getMyTermView`'s own re-read of "what's waiting next" — nothing is,
    // since the only pending renewal was just cancelled inside the transaction above.
    termFindFirst.mockResolvedValueOnce(pending()).mockResolvedValueOnce(null);
    await run();
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 30n },
      data: { status: 'CANCELLED' },
    });
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 20n }, data: { status: 'CANCELLED' } });
    const [, src, opts] = raiseRenewal.mock.calls[0];
    expect(src).toMatchObject({ memberId: 5n, categoryId: 2n, feePlanId: null });
    expect(src.previousValidTill.toISOString().slice(0, 10)).toBe('2027-03-31');
    expect(opts.planOverride.id).toBe(8n);
  });
});

// getMyTermView also runs at the end of a successful decline/resume — the same internal
// self-call noted above. Its own `member.findFirst` / `membershipTerm.findFirst` reads are
// queued explicitly below (in call order: the in-transaction read(s) first, then a FULL-shape
// value for getMyTermView's read) rather than relying on a single shared default, since the two
// reads need different fields and a partial shape crashes `isoDay(undefined)` on the second call.
const DECLINE_TX_MEMBER = {
  status: 'ACTIVE',
  current_term: {
    id: 10n,
    status: 'ACTIVE',
    valid_till: day('2027-03-31'),
    renewal_declined_at: null,
  },
};
const DECLINE_FULL_MEMBER = {
  status: 'ACTIVE',
  current_term: {
    id: 10n,
    term_type: 'RENEWAL',
    status: 'ACTIVE',
    valid_from: day('2026-04-01'),
    valid_till: day('2027-03-31'),
    fee_plan: null,
    renewal_declined_at: new Date(),
  },
};

describe('declineRenewal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memberFindFirst.mockResolvedValue(DECLINE_TX_MEMBER);
  });

  it('cancels a raised, unpaid renewal and records the decision on the current term', async () => {
    memberFindFirst
      .mockResolvedValueOnce(DECLINE_TX_MEMBER)
      .mockResolvedValueOnce(DECLINE_FULL_MEMBER);
    termFindFirst.mockResolvedValueOnce(pending()).mockResolvedValueOnce(null);
    await service.declineRenewal(5n, AUDIT);
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 30n },
      data: { status: 'CANCELLED' },
    });
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 20n }, data: { status: 'CANCELLED' } });
    expect(termUpdate).toHaveBeenCalledWith({
      where: { id: 10n },
      data: { renewal_declined_at: expect.any(Date) },
    });
  });

  it('records the decision when no invoice has been raised yet', async () => {
    memberFindFirst
      .mockResolvedValueOnce(DECLINE_TX_MEMBER)
      .mockResolvedValueOnce(DECLINE_FULL_MEMBER);
    termFindFirst.mockResolvedValue(null);
    await service.declineRenewal(5n, AUDIT);
    expect(invoiceUpdate).not.toHaveBeenCalled();
    expect(termUpdate).toHaveBeenCalledWith({
      where: { id: 10n },
      data: { renewal_declined_at: expect.any(Date) },
    });
  });

  it('refuses once the renewal is paid', async () => {
    termFindFirst.mockResolvedValue(pending({ status: 'PAID_UPCOMING' }));
    await expect(service.declineRenewal(5n, AUDIT)).rejects.toMatchObject({
      messageKey: 'renewal.cannotDecline',
    });
  });
});

describe('resumeRenewal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the decision and raises the renewal when the term ends inside the window', async () => {
    memberFindFirst
      .mockResolvedValueOnce({
        status: 'EXPIRED',
        current_term: {
          id: 10n,
          valid_till: day('2026-01-31'),
          category_id: 2n,
          tier_id: null,
          fee_plan_id: 7n,
          renewal_declined_at: new Date(),
        },
      })
      .mockResolvedValueOnce({
        status: 'EXPIRED',
        current_term: {
          id: 10n,
          term_type: 'RENEWAL',
          status: 'ACTIVE',
          valid_from: day('2025-04-01'),
          valid_till: day('2026-01-31'),
          fee_plan: null,
          renewal_declined_at: null,
        },
      });
    termFindFirst.mockResolvedValue(null);
    raiseRenewal.mockResolvedValue({
      outcome: 'RAISED',
      termId: 21n,
      invoiceId: 31n,
      invoiceNumber: 'IN3',
      total: '23600.00',
    });
    await service.resumeRenewal(5n, AUDIT);
    expect(termUpdate).toHaveBeenCalledWith({
      where: { id: 10n },
      data: { renewal_declined_at: null },
    });
    expect(raiseRenewal.mock.calls[0][1]).toMatchObject({ memberId: 5n, feePlanId: 7n });
  });

  it('refuses when nothing was declined', async () => {
    memberFindFirst.mockResolvedValue({
      status: 'ACTIVE',
      current_term: {
        id: 10n,
        valid_till: day('2027-03-31'),
        category_id: 2n,
        tier_id: null,
        fee_plan_id: 7n,
        renewal_declined_at: null,
      },
    });
    await expect(service.resumeRenewal(5n, AUDIT)).rejects.toMatchObject({
      messageKey: 'renewal.notDeclined',
    });
  });
});
