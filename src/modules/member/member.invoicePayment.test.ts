import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoiceFindFirst = vi.fn();
const invoiceUpdate = vi.fn();
const membershipTermUpdateMany = vi.fn();
const receiptCount = vi.fn();
const receiptCreate = vi.fn();
const paymentCount = vi.fn();
const paymentCreate = vi.fn();
const auditLogCreate = vi.fn();
const findMemberById = vi.fn();
const updateMember = vi.fn();
const recordStatusChange = vi.fn();

const tx = {
  invoice: { update: invoiceUpdate },
  membershipTerm: { updateMany: membershipTermUpdateMany },
  payment: { count: paymentCount, create: paymentCreate },
  receipt: { count: receiptCount, create: receiptCreate },
  auditLog: { create: auditLogCreate },
};

vi.mock('@db/prisma', () => ({
  prisma: {
    invoice: { findFirst: (...a: unknown[]) => invoiceFindFirst(...a) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(tx),
  },
}));

vi.mock('@modules/member/member.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modules/member/member.repository')>();
  return {
    ...actual,
    findMemberById: (...a: unknown[]) => findMemberById(...a),
    updateMember: (...a: unknown[]) => updateMember(...a),
    recordStatusChange: (...a: unknown[]) => recordStatusChange(...a),
  };
});

const { recordInvoicePayment } = await import('@modules/member/member.service');

const ACTOR = { id: 9n, ip: '127.0.0.1', userAgent: 'vitest', requestId: 'req-1' };

const OPEN_INVOICE = {
  id: 42n,
  member_id: 5n,
  invoice_number: 'IN202603001',
  status: 'ISSUED',
  total_amount: { toFixed: () => '23600.00' },
  amount_paid: { toFixed: () => '0.00' },
};

/*
  The `payOwnInvoice` block stood here — one click, invoice PAID, membership
  ACTIVE, attributed to the member. That path is gone: a member now files a claim
  an admin verifies, covered by `billing/paymentClaim.test.ts`. What survives
  below is the ADMIN path, which is unchanged and still the only way an invoice
  is settled without a claim.
*/

describe('recordInvoicePayment (admin path, unchanged behaviour)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoiceFindFirst.mockResolvedValue(OPEN_INVOICE);
    findMemberById.mockResolvedValue({ id: 5n, status: 'PENDING', joined_on: null });
    updateMember.mockResolvedValue({ id: 5n, status: 'ACTIVE' });
    invoiceUpdate.mockResolvedValue({ id: 42n, status: 'PAID' });
    paymentCount.mockResolvedValue(0);
    paymentCreate.mockResolvedValue({ id: 7n, payment_number: 'PY202603001' });
    receiptCount.mockResolvedValue(0);
    receiptCreate.mockResolvedValue({ id: 1n, receipt_number: 'RC202603001' });
  });

  it('still attributes the status change to the acting admin', async () => {
    await recordInvoicePayment(5n, 42n, ACTOR);

    expect(recordStatusChange).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ changed_by_admin_id: 9n }),
    );
  });

  it('still writes the audit row as ADMIN', async () => {
    await recordInvoicePayment(5n, 42n, ACTOR);

    expect(auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actor_type: 'ADMIN' }) }),
    );
  });
});
