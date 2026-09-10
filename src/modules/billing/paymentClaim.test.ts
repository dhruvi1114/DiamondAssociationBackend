import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoiceFindFirst = vi.fn();
const submissionCount = vi.fn();
const submissionCreate = vi.fn();
const memberFindFirst = vi.fn();
const storeProof = vi.fn();
const removeProof = vi.fn();
const notifyClaimReceived = vi.fn();

/** The transaction client the service writes through. */
const tx = {
  paymentSubmission: { create: (...a: unknown[]) => submissionCreate(...a) },
  member: { findFirst: (...a: unknown[]) => memberFindFirst(...a) },
};

vi.mock('@db/prisma', () => ({
  prisma: {
    invoice: { findFirst: (...a: unknown[]) => invoiceFindFirst(...a) },
    paymentSubmission: { count: (...a: unknown[]) => submissionCount(...a) },
    $transaction: (fn: (client: unknown) => unknown) => fn(tx),
  },
}));

vi.mock('@modules/billing/membershipNotify', () => ({
  notifyClaimReceived: (...a: unknown[]) => notifyClaimReceived(...a),
}));

vi.mock('@modules/billing/paymentProof.service', () => ({
  storeProof: (...a: unknown[]) => storeProof(...a),
  removeProof: (...a: unknown[]) => removeProof(...a),
}));

const { submitInvoiceClaim } = await import('@modules/billing/paymentClaim.service');

const PROOF = { buffer: Buffer.from('x'), originalname: 'receipt.png' };
const ACTOR = { userId: 9n };

const CLAIM = {
  method: 0,
  reference_no: 'UTR123456789',
  amount: 23600,
  paid_on: new Date('2026-09-09T00:00:00.000Z'),
};

const OPEN_INVOICE = {
  id: 42n,
  member_id: 5n,
  invoice_number: 'IN202603001',
  status: 'ISSUED',
  total_amount: { toFixed: () => '23600.00' },
};

describe('submitInvoiceClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoiceFindFirst.mockResolvedValue(OPEN_INVOICE);
    submissionCount.mockResolvedValue(0);
    storeProof.mockResolvedValue({ key: 'invoices/42/proofs/uuid.png' });
    submissionCreate.mockResolvedValue({ id: 3n, reference_no: 'UTR123456789', status: 0 });
    memberFindFirst.mockResolvedValue({
      id: 5n,
      company_name: 'ABC',
      contacts: [{ email: 'owner@abc.test' }],
    });
  });

  it('rejects an invoice that does not belong to the caller', async () => {
    invoiceFindFirst.mockResolvedValue(null);

    await expect(submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR)).rejects.toMatchObject({
      messageKey: 'member.invoiceNotFound',
    });
  });

  it('rejects an invoice that is already paid', async () => {
    invoiceFindFirst.mockResolvedValue({ ...OPEN_INVOICE, status: 'PAID' });

    await expect(submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR)).rejects.toMatchObject({
      messageKey: 'member.invoiceAlreadyPaid',
    });
  });

  it('rejects a draft invoice, which is not payable at all', async () => {
    invoiceFindFirst.mockResolvedValue({ ...OPEN_INVOICE, status: 'DRAFT' });

    await expect(submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR)).rejects.toMatchObject({
      messageKey: 'member.invoiceNotPayable',
    });
  });

  // A member unsure whether the first went through files a second, and the same
  // money would then be verified twice.
  it('refuses a second claim while one is still being checked', async () => {
    submissionCount.mockResolvedValue(1);

    await expect(submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR)).rejects.toMatchObject({
      messageKey: 'billing.claimAlreadyPending',
    });

    expect(storeProof).not.toHaveBeenCalled();
  });

  it('stores the receipt and records the key the SERVER produced', async () => {
    await submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR);

    expect(storeProof).toHaveBeenCalledWith(42n, PROOF);
    expect(submissionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoice_id: 42n,
          proof_path: 'invoices/42/proofs/uuid.png',
          reference_no: 'UTR123456789',
        }),
      }),
    );
  });

  // The claim is an assertion until an admin checks it. Nothing about the
  // invoice or the membership may move here.
  it('leaves the invoice alone — filing a claim is not paying', async () => {
    await submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR);

    const created = submissionCreate.mock.calls[0]?.[0] as { data: { status: number } };

    expect(created.data.status).toBe(0);
  });

  // The member is not active while this is checked, and the invoice does not
  // change — so without the acknowledgement nothing on screen says it worked.
  it('acknowledges the claim to the company primary contact', async () => {
    await submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR);

    expect(notifyClaimReceived).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ toAddress: 'owner@abc.test', invoiceNumber: 'IN202603001' }),
      'UTR123456789',
    );
  });

  it('deletes the stored receipt when the claim row cannot be written', async () => {
    submissionCreate.mockRejectedValue(new Error('constraint'));

    await expect(submitInvoiceClaim(5n, 42n, CLAIM, PROOF, ACTOR)).rejects.toThrow('constraint');

    expect(removeProof).toHaveBeenCalledWith('invoices/42/proofs/uuid.png');
  });
});
