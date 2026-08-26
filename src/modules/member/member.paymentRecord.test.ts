import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const invoiceFindFirst = vi.fn();
const invoiceUpdate = vi.fn();
const termUpdateMany = vi.fn();
const paymentCreate = vi.fn();
const paymentCount = vi.fn();
const receiptCreate = vi.fn();
const receiptCount = vi.fn();
const findMemberById = vi.fn();

const tx = {
  invoice: { update: (...a: unknown[]) => invoiceUpdate(...a) },
  membershipTerm: { updateMany: (...a: unknown[]) => termUpdateMany(...a) },
  payment: {
    create: (...a: unknown[]) => paymentCreate(...a),
    count: (...a: unknown[]) => paymentCount(...a),
  },
  receipt: {
    create: (...a: unknown[]) => receiptCreate(...a),
    count: (...a: unknown[]) => receiptCount(...a),
  },
};

vi.mock('@db/prisma', () => ({
  prisma: {
    invoice: { findFirst: (...a: unknown[]) => invoiceFindFirst(...a) },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  },
}));

vi.mock('@modules/member/member.repository', () => ({
  findMemberById: (...a: unknown[]) => findMemberById(...a),
  updateMember: vi.fn(),
  recordStatusChange: vi.fn(),
  findMemberByUserId: vi.fn(),
  createMember: vi.fn(),
  createOwnerTeamRow: vi.fn(),
  findMemberDetail: vi.fn(),
  listStatusHistory: vi.fn(),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: vi.fn() }));

const { recordInvoicePayment } = await import('@modules/member/member.service');
const { PAYMENT_METHOD, PAYMENT_STATUS, MANUAL_PROVIDER } =
  await import('@modules/billing/payment.constants');

const actor = { id: 3n, ip: null, userAgent: null, requestId: null };

beforeEach(() => {
  vi.clearAllMocks();
  invoiceFindFirst.mockResolvedValue({
    id: 14n,
    invoice_number: 'IN202603001',
    status: 'ISSUED',
    total_amount: new Prisma.Decimal('23600.00'),
    amount_paid: new Prisma.Decimal('0.00'),
  });
  findMemberById.mockResolvedValue({ id: 27n, status: 'ACTIVE', joined_on: new Date() });
  invoiceUpdate.mockResolvedValue({ id: 14n, status: 'PAID' });
  termUpdateMany.mockResolvedValue({ count: 0 });
  paymentCount.mockResolvedValue(0);
  paymentCreate.mockResolvedValue({ id: 9n, payment_number: 'PY202603001' });
  receiptCount.mockResolvedValue(0);
  receiptCreate.mockResolvedValue({ id: 5n, receipt_number: 'RC202603001' });
});

describe('recordInvoicePayment', () => {
  it('writes one Payments row for the invoice total, marked SUCCESS and MANUAL', async () => {
    await recordInvoicePayment(27n, 14n, actor);

    expect(paymentCreate).toHaveBeenCalledOnce();

    const data = paymentCreate.mock.calls[0][0].data;

    expect(data).toMatchObject({
      invoice_id: 14n,
      member_id: 27n,
      method: PAYMENT_METHOD.NEFT,
      provider: MANUAL_PROVIDER,
      status: PAYMENT_STATUS.SUCCESS,
      recorded_by_admin_id: 3n,
    });
    expect(data.amount.toString()).toBe('23600');
    expect(data.paid_at).toBeInstanceOf(Date);
  });

  it('points the receipt at the payment it acknowledges', async () => {
    await recordInvoicePayment(27n, 14n, actor);

    expect(receiptCreate.mock.calls[0][0].data).toMatchObject({ payment_id: 9n });
  });

  it('writes nothing when the invoice is already paid', async () => {
    invoiceFindFirst.mockResolvedValue({
      id: 14n,
      invoice_number: 'IN202603001',
      status: 'PAID',
      total_amount: new Prisma.Decimal('23600.00'),
      amount_paid: new Prisma.Decimal('23600.00'),
    });

    await expect(recordInvoicePayment(27n, 14n, actor)).rejects.toMatchObject({
      messageKey: 'member.invoiceAlreadyPaid',
    });

    expect(paymentCreate).not.toHaveBeenCalled();
  });
});
