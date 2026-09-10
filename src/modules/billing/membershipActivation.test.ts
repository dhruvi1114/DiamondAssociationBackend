import { beforeEach, describe, expect, it, vi } from 'vitest';

const membershipTermUpdateMany = vi.fn();
const findMemberById = vi.fn();
const updateMember = vi.fn();
const recordStatusChange = vi.fn();

const tx = { membershipTerm: { updateMany: membershipTermUpdateMany } };

vi.mock('@modules/member/member.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modules/member/member.repository')>();
  return {
    ...actual,
    findMemberById: (...a: unknown[]) => findMemberById(...a),
    updateMember: (...a: unknown[]) => updateMember(...a),
    recordStatusChange: (...a: unknown[]) => recordStatusChange(...a),
  };
});

const { activateMembershipForInvoice } = await import('@modules/billing/membershipActivation');

const PARAMS = {
  invoiceId: 42n,
  memberId: 5n,
  invoiceNumber: 'IN202603001',
  changedByAdminId: 9n,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = () => activateMembershipForInvoice(tx as any, PARAMS);

describe('activateMembershipForInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMemberById.mockResolvedValue({ id: 5n, status: 'PENDING', joined_on: null });
    updateMember.mockResolvedValue({ id: 5n, status: 'ACTIVE' });
  });

  // The whole point: an admin verifies a claim, and the membership actually
  // switches on rather than sitting PENDING behind a paid invoice.
  it('activates every term the invoice was raised for', async () => {
    await run();

    expect(membershipTermUpdateMany).toHaveBeenCalledWith({
      where: { invoice_id: 42n, status: 'PENDING_PAYMENT' },
      data: { status: 'ACTIVE' },
    });
  });

  it('moves a PENDING member to ACTIVE and stamps the joining date', async () => {
    await run();

    expect(updateMember).toHaveBeenCalledWith(
      tx,
      5n,
      expect.objectContaining({ status: 'ACTIVE', joined_on: expect.any(Date) }),
    );
    expect(recordStatusChange).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ reason: 'Invoice IN202603001 paid', changed_by_admin_id: 9n }),
    );
  });

  // A renewal is paid by a company that is already ACTIVE. Re-running the
  // transition would write a status-change row saying they joined again.
  it('leaves an already-active member alone', async () => {
    findMemberById.mockResolvedValue({ id: 5n, status: 'ACTIVE', joined_on: new Date() });

    await run();

    expect(updateMember).not.toHaveBeenCalled();
    expect(recordStatusChange).not.toHaveBeenCalled();
    // The terms still go live — that is what the renewal bought.
    expect(membershipTermUpdateMany).toHaveBeenCalled();
  });

  it('keeps the original joining date on a member who already has one', async () => {
    const joined = new Date('2025-01-01T00:00:00.000Z');
    findMemberById.mockResolvedValue({ id: 5n, status: 'PENDING', joined_on: joined });

    await run();

    expect(updateMember).toHaveBeenCalledWith(tx, 5n, { status: 'ACTIVE' });
  });
});
