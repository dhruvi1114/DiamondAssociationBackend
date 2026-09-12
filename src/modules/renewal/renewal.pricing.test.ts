import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  loadLivePlan,
  loadRenewalPlan,
  pickRenewalPlan,
  priceRenewal,
  type RenewalPlan,
} from '@modules/renewal/renewal.pricing';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const D = (v: string) => new Prisma.Decimal(v);

const plan = (over: Partial<RenewalPlan>): RenewalPlan => ({
  id: 1n,
  billing_cycle: 'YEARLY',
  name: 'Best Value',
  renewal_amount: D('20000'),
  tax_rate: D('18'),
  currency: 'INR',
  effective_from: day('2026-04-01'),
  effective_to: null,
  is_active: true,
  price_scope: 'ALL_MEMBERS',
  ...over,
});

describe('pickRenewalPlan', () => {
  it('keeps the member on their own plan while it is live', () => {
    const own = plan({ id: 1n });
    expect(pickRenewalPlan(own, plan({ id: 2n }), day('2027-03-16')).id).toBe(1n);
  });

  it('moves to the live same-cycle plan when it applies to all members', () => {
    const own = plan({ id: 1n, is_active: false, effective_to: day('2026-12-31') });
    const live = plan({ id: 2n, renewal_amount: D('22000'), price_scope: 'ALL_MEMBERS' });
    expect(pickRenewalPlan(own, live, day('2027-03-16')).id).toBe(2n);
  });

  it('stays on the closed plan when the new price is for new members only', () => {
    const own = plan({ id: 1n, is_active: false, effective_to: day('2026-12-31') });
    const live = plan({ id: 2n, price_scope: 'NEW_MEMBERS_ONLY' });
    expect(pickRenewalPlan(own, live, day('2027-03-16')).id).toBe(1n);
  });

  it('stays on the closed plan when nothing is live for the cycle', () => {
    const own = plan({ id: 1n, is_active: false });
    expect(pickRenewalPlan(own, null, day('2027-03-16')).id).toBe(1n);
  });
});

describe('priceRenewal', () => {
  it('charges the full renewal price plus tax on a full term', () => {
    const p = priceRenewal(D('20000'), D('18'), {
      months: 12,
      durationMonths: 12,
      prorated: false,
    } as never);
    expect(p.total.toFixed(2)).toBe('23600.00');
  });

  it('prorates by whole months and taxes the prorated line', () => {
    const p = priceRenewal(D('7000'), D('18'), {
      months: 1,
      durationMonths: 3,
      prorated: true,
    } as never);
    expect(p.net.toFixed(2)).toBe('2333.33');
    expect(p.tax.toFixed(2)).toBe('420.00');
    expect(p.total.toFixed(2)).toBe('2753.33');
  });
});

describe('loadRenewalPlan', () => {
  it('returns own plan when it is live on the day', async () => {
    const own = plan({ id: 1n });
    const testDay = day('2027-03-16');

    const db = {
      feePlan: {
        findFirst: vi.fn().mockResolvedValueOnce(own).mockResolvedValueOnce(null),
      },
    };

    const result = await loadRenewalPlan(db as never, 1n, testDay);
    expect(result).toEqual(own);
    expect(db.feePlan.findFirst).toHaveBeenCalledTimes(2);
  });

  it('returns successor plan when own is closed and successor is ALL_MEMBERS', async () => {
    const own = plan({
      id: 1n,
      is_active: false,
      effective_to: day('2026-12-31'),
    });
    const live = plan({
      id: 2n,
      renewal_amount: D('22000'),
      price_scope: 'ALL_MEMBERS',
    });
    const testDay = day('2027-03-16');

    const db = {
      feePlan: {
        findFirst: vi.fn().mockResolvedValueOnce(own).mockResolvedValueOnce(live),
      },
    };

    const result = await loadRenewalPlan(db as never, 1n, testDay);
    expect(result?.id).toBe(2n);
    expect(db.feePlan.findFirst).toHaveBeenCalledTimes(2);
  });

  it('returns null when plan is not found', async () => {
    const testDay = day('2027-03-16');

    const db = {
      feePlan: {
        findFirst: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const result = await loadRenewalPlan(db as never, 999n, testDay);
    expect(result).toBeNull();
    expect(db.feePlan.findFirst).toHaveBeenCalledTimes(1);
  });

  it('queries with correct where and orderBy for live plans', async () => {
    const own = plan({ id: 1n });
    const testDay = day('2027-03-16');

    const db = {
      feePlan: {
        findFirst: vi.fn().mockResolvedValueOnce(own).mockResolvedValueOnce(null),
      },
    };

    await loadRenewalPlan(db as never, 1n, testDay);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondCall = (db.feePlan.findFirst as any).mock.calls[1][0];
    expect(secondCall.where).toMatchObject({
      billing_cycle: 'YEARLY',
      is_active: true,
      deletedAt: null,
      structure: { is_active: true, deletedAt: null },
      effective_from: { lte: testDay },
      OR: [{ effective_to: null }, { effective_to: { gte: testDay } }],
    });
    expect(secondCall.orderBy).toEqual({ effective_from: 'desc' });
  });
});

describe('loadLivePlan', () => {
  it('returns plan when found and live, null otherwise', async () => {
    const live = plan({ id: 1n });
    const testDay = day('2027-03-16');

    const db = {
      feePlan: {
        findFirst: vi.fn().mockResolvedValueOnce(live),
      },
    };

    const result = await loadLivePlan(db as never, 1n, testDay);
    expect(result).toEqual(live);
  });

  it('returns null when plan not found', async () => {
    const testDay = day('2027-03-16');

    const db = {
      feePlan: {
        findFirst: vi.fn().mockResolvedValueOnce(null),
      },
    };

    const result = await loadLivePlan(db as never, 999n, testDay);
    expect(result).toBeNull();
  });

  it('queries with id and live predicate fields', async () => {
    const live = plan({ id: 1n });
    const testDay = day('2027-03-16');

    const db = {
      feePlan: {
        findFirst: vi.fn().mockResolvedValueOnce(live),
      },
    };

    await loadLivePlan(db as never, 1n, testDay);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callArgs = (db.feePlan.findFirst as any).mock.calls[0][0];
    expect(callArgs.where).toMatchObject({
      id: 1n,
      deletedAt: null,
      is_active: true,
      structure: { is_active: true, deletedAt: null },
      effective_from: { lte: testDay },
      OR: [{ effective_to: null }, { effective_to: { gte: testDay } }],
    });
  });
});
