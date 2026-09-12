import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const D = (v: string) => new Prisma.Decimal(v);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const termFindFirst = vi.fn();
const termCreate = vi.fn();
const termUpdate = vi.fn();
const invoiceCreate = vi.fn();
const feePlanFindFirst = vi.fn();
const executeRaw = vi.fn();

const tx = {
  $executeRaw: executeRaw,
  membershipTerm: { findFirst: termFindFirst, create: termCreate, update: termUpdate },
  invoice: { create: invoiceCreate },
  feePlan: { findFirst: feePlanFindFirst },
};

vi.mock('@helpers/documentNumber', () => ({
  allocateInvoiceNumber: vi.fn(async () => 'IN202701001'),
}));
vi.mock('@helpers/audit', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { raiseRenewal } = await import('@modules/renewal/renewal.raise');

const QUARTERLY = {
  id: 7n,
  billing_cycle: 'QUARTERLY',
  name: 'Standard',
  renewal_amount: D('7000'),
  tax_rate: D('18'),
  currency: 'INR',
  effective_from: day('2026-04-01'),
  effective_to: null,
  is_active: true,
  price_scope: 'ALL_MEMBERS',
};

const SRC = {
  memberId: 5n,
  categoryId: 2n,
  tierId: null,
  feePlanId: 7n,
  previousValidTill: day('2027-03-11'),
};
const OPTS = { today: day('2027-02-24'), basis: 'financial_year' as const, dueDays: 15 };

describe('raiseRenewal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    termFindFirst.mockResolvedValue(null);
    feePlanFindFirst.mockResolvedValue(QUARTERLY);
    termCreate.mockResolvedValue({ id: 99n });
    invoiceCreate.mockResolvedValue({ id: 500n, invoice_number: 'IN202701001' });
  });

  it('skips when a live term already starts the day after', async () => {
    termFindFirst.mockResolvedValue({ id: 1n });
    await expect(raiseRenewal(tx as never, SRC, OPTS)).resolves.toEqual({
      outcome: 'SKIPPED',
      reason: 'ALREADY_RAISED',
    });
    expect(invoiceCreate).not.toHaveBeenCalled();
  });

  it('skips a term with no plan', async () => {
    await expect(raiseRenewal(tx as never, { ...SRC, feePlanId: null }, OPTS)).resolves.toEqual({
      outcome: 'SKIPPED',
      reason: 'NO_PLAN',
    });
  });

  it('never raises a zero invoice', async () => {
    feePlanFindFirst.mockResolvedValue({ ...QUARTERLY, renewal_amount: D('0') });
    await expect(raiseRenewal(tx as never, SRC, OPTS)).resolves.toEqual({
      outcome: 'SKIPPED',
      reason: 'NO_PRICE',
    });
    expect(termCreate).not.toHaveBeenCalled();
  });

  it('raises a contiguous, prorated term under financial_year', async () => {
    const result = await raiseRenewal(tx as never, SRC, OPTS);

    expect(result).toMatchObject({
      outcome: 'RAISED',
      termId: 99n,
      invoiceId: 500n,
      total: '2753.33',
    });
    const term = termCreate.mock.calls[0][0].data;
    expect(term).toMatchObject({
      term_type: 'RENEWAL',
      status: 'PENDING_PAYMENT',
      fee_plan_id: 7n,
    });
    expect(term.valid_from.toISOString().slice(0, 10)).toBe('2027-03-12');
    expect(term.valid_till.toISOString().slice(0, 10)).toBe('2027-03-31');
    const invoice = invoiceCreate.mock.calls[0][0].data;
    expect(invoice).toMatchObject({ invoice_type: 'RENEWAL', status: 'ISSUED' });
    expect(invoice.total_amount.toFixed(2)).toBe('2753.33');
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 99n }, data: { invoice_id: 500n } });
  });
});
