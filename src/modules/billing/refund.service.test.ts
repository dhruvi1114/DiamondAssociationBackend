import { describe, expect, it, vi, beforeEach } from 'vitest';

const findRefund = vi.fn();
const updateRefund = vi.fn();
const listRefunds = vi.fn();
const countRefunds = vi.fn();
const paymentUpdate = vi.fn();
const writeAudit = vi.fn();
const queueNotification = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ payment: { update: (...a: unknown[]) => paymentUpdate(...a) } }),
  },
}));

vi.mock('@modules/billing/refund.repository', () => ({
  findRefund: (...a: unknown[]) => findRefund(...a),
  updateRefund: (...a: unknown[]) => updateRefund(...a),
  listRefunds: (...a: unknown[]) => listRefunds(...a),
  countRefunds: (...a: unknown[]) => countRefunds(...a),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

vi.mock('@notifications/outbox', () => ({
  queueNotification: (...a: unknown[]) => queueNotification(...a),
}));

const service = await import('@modules/billing/refund.service');
const { REFUND_STATUS, PAYMENT_STATUS } = await import('@modules/billing/payment.constants');

const actor = { adminId: 9n, ip: null, userAgent: null, requestId: null };

/** A refund as the repository hands it over, at whatever status the test needs. */
const refundAt = (status: number) => ({
  id: 5n,
  refund_number: 'RF202603001',
  amount: { toFixed: () => '1000.00' },
  status,
  reason: null,
  provider_refund_id: null,
  processed_at: null,
  requested_by: { id: 3n, full_name: 'Priya Nair' },
  approved_by: null,
  finalised_by: null,
  createdAt: new Date('2026-09-01'),
  payment: {
    id: 77n,
    amount: { toFixed: () => '1000.00' },
    invoice: { id: 12n, invoice_number: 'INV202603004' },
    member: {
      id: 3n,
      company_name: 'Shah Diamonds LLP',
      contacts: [{ email: 'accounts@shahdiamonds.com' }],
    },
    guest_registrant: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  updateRefund.mockImplementation((_db, id: bigint, data: { status: number }) =>
    Promise.resolve({ id, status: data.status }),
  );
});

describe('approveRefund', () => {
  it('releases a requested refund and records who released it', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.REQUESTED));

    const row = await service.approveRefund(5n, actor);

    expect(updateRefund.mock.calls[0][2]).toMatchObject({
      status: REFUND_STATUS.PROCESSING,
      approved_by: { connect: { id: 9n } },
    });
    expect(row).toEqual({ id: '5', status: REFUND_STATUS.PROCESSING });
  });

  it('writes to the payer, at the company’s primary contact', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.REQUESTED));

    await service.approveRefund(5n, actor);

    expect(queueNotification.mock.calls[0][1]).toMatchObject({
      templateCode: 'refund.approved',
      toAddress: 'accounts@shahdiamonds.com',
      memberId: 3n,
    });
  });

  it('still approves when there is nowhere to write to', async () => {
    const noEmail = refundAt(REFUND_STATUS.REQUESTED);
    noEmail.payment.member = { id: 3n, company_name: 'Shah Diamonds LLP', contacts: [] } as never;
    findRefund.mockResolvedValue(noEmail);

    // A refund that cannot be emailed is still a refund. Failing the decision
    // over a missing address would leave the money in limbo to protect a notice.
    await expect(service.approveRefund(5n, actor)).resolves.toMatchObject({
      status: REFUND_STATUS.PROCESSING,
    });
    expect(queueNotification).not.toHaveBeenCalled();
  });

  it('refuses one that is already processing, so a stale tab cannot re-approve it', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.PROCESSING));

    await expect(service.approveRefund(5n, actor)).rejects.toMatchObject({
      messageKey: 'billing.refundWrongStatus',
    });
    expect(updateRefund).not.toHaveBeenCalled();
  });

  it('refuses one already sent, which is money that cannot be un-approved', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.COMPLETED));

    await expect(service.approveRefund(5n, actor)).rejects.toMatchObject({
      messageKey: 'billing.refundWrongStatus',
    });
  });
});

describe('rejectRefund', () => {
  it('puts the payment back to SUCCESS, because no money actually left', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.REQUESTED));

    await service.rejectRefund(5n, { reason: 'Attended day one' }, actor);

    expect(updateRefund.mock.calls[0][2]).toMatchObject({
      status: REFUND_STATUS.REJECTED,
      reason: 'Attended day one',
      // Who ended it, kept apart from "who touched it last".
      finalised_by: { connect: { id: 9n } },
    });
    expect(paymentUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 77n },
      data: { status: PAYMENT_STATUS.SUCCESS },
    });
  });
});

describe('completeRefund', () => {
  it('stamps the bank reference and the moment the money went', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.PROCESSING));
    const sentAt = new Date('2026-09-03T10:00:00Z');

    await service.completeRefund(5n, { reference: 'UTR123456' }, actor, sentAt);

    expect(updateRefund.mock.calls[0][2]).toMatchObject({
      status: REFUND_STATUS.COMPLETED,
      provider_refund_id: 'UTR123456',
      processed_at: sentAt,
      finalised_by: { connect: { id: 9n } },
    });
    expect(queueNotification.mock.calls[0][1]).toMatchObject({
      templateCode: 'refund.completed',
      payload: expect.objectContaining({ reference: 'UTR123456' }),
    });
  });

  it('refuses one nobody approved — money cannot be sent before it is released', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.REQUESTED));

    await expect(
      service.completeRefund(5n, { reference: 'UTR123456' }, actor),
    ).rejects.toMatchObject({ messageKey: 'billing.refundWrongStatus' });
  });
});

describe('failRefund', () => {
  it('marks a bounced transfer FAILED rather than returning it to REQUESTED', async () => {
    findRefund.mockResolvedValue(refundAt(REFUND_STATUS.PROCESSING));

    await service.failRefund(5n, { reason: 'Account number rejected' }, actor);

    // The approval genuinely happened; a bank rejecting an account number is not
    // a reason to erase it and make somebody approve the same refund twice.
    expect(updateRefund.mock.calls[0][2]).toMatchObject({
      status: REFUND_STATUS.FAILED,
      reason: 'Account number rejected',
      finalised_by: { connect: { id: 9n } },
    });
    // Nothing is sent: "your refund failed" is a message the reader can do
    // nothing about. They hear again when it completes.
    expect(queueNotification).not.toHaveBeenCalled();
  });
});

describe('the queue', () => {
  it('carries the staff names, so the queue never shows a bare admin id', async () => {
    const decided = refundAt(REFUND_STATUS.COMPLETED);

    decided.approved_by = { id: 9n, full_name: 'Meera Joshi' } as never;
    decided.finalised_by = { id: 12n, full_name: 'Arun Desai' } as never;
    listRefunds.mockResolvedValue([decided]);
    countRefunds.mockResolvedValue(1);

    const result = await service.listRefunds({ page: 1, limit: 20 });

    expect(result.rows[0]).toMatchObject({
      requested_by: 'Priya Nair',
      approved_by: 'Meera Joshi',
      finalised_by: 'Arun Desai',
    });
  });

  it('names the payer whether they were a member or a guest', async () => {
    const guest = refundAt(REFUND_STATUS.REQUESTED);
    guest.payment.member = null;
    guest.payment.guest_registrant = {
      full_name: 'Ramesh Patel',
      company_name: null,
      email: 'ramesh@example.com',
    } as never;

    listRefunds.mockResolvedValue([refundAt(REFUND_STATUS.REQUESTED), guest]);
    countRefunds.mockResolvedValue(2);

    const result = await service.listRefunds({ page: 1, limit: 20 });

    expect(result.rows[0]?.payer).toEqual({ kind: 'MEMBER', name: 'Shah Diamonds LLP' });
    expect(result.rows[1]?.payer).toEqual({ kind: 'GUEST', name: 'Ramesh Patel' });
    expect(result.total).toBe(2);
  });

  it('asks for everything when nothing was filtered', async () => {
    listRefunds.mockResolvedValue([]);
    countRefunds.mockResolvedValue(0);

    await service.listRefunds({ page: 1, limit: 20 });

    // Not `{ AND: [] }` — an empty AND is a clause that has to be reasoned
    // about, and this one means "no opinion".
    expect(listRefunds.mock.calls[0][1]).toEqual({});
  });

  it('filters by status when one was asked for', async () => {
    listRefunds.mockResolvedValue([]);
    countRefunds.mockResolvedValue(0);

    await service.listRefunds({ page: 1, limit: 20, status: REFUND_STATUS.REQUESTED });

    expect(listRefunds.mock.calls[0][1]).toEqual({
      AND: [{ status: REFUND_STATUS.REQUESTED }],
    });
  });

  it('searches the refund number, the invoice number and the payer', async () => {
    listRefunds.mockResolvedValue([]);
    countRefunds.mockResolvedValue(0);

    await service.listRefunds({ page: 1, limit: 20, search: 'shah' });

    const where = listRefunds.mock.calls[0][1] as { AND: [{ OR: unknown[] }] };

    expect(where.AND[0].OR).toHaveLength(5);
    expect(where.AND[0].OR[0]).toEqual({
      refund_number: { contains: 'shah', mode: 'insensitive' },
    });
  });

  it('narrows by status AND search together, not either one', async () => {
    listRefunds.mockResolvedValue([]);
    countRefunds.mockResolvedValue(0);

    await service.listRefunds({
      page: 1,
      limit: 20,
      status: REFUND_STATUS.COMPLETED,
      search: 'RF',
    });

    const where = listRefunds.mock.calls[0][1] as { AND: unknown[] };

    expect(where.AND).toHaveLength(2);
  });
});

describe('a refund that is not there', () => {
  it('is not found, rather than a crash', async () => {
    findRefund.mockResolvedValue(null);

    await expect(service.approveRefund(5n, actor)).rejects.toMatchObject({
      messageKey: 'billing.refundNotFound',
    });
  });
});
