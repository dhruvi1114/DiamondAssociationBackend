import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMemberById = vi.fn();
const updateMember = vi.fn();
const recordStatusChange = vi.fn();
const getSettingMock = vi.fn();

vi.mock('@modules/member/member.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modules/member/member.repository')>();
  return {
    ...actual,
    findMemberById: (...a: unknown[]) => findMemberById(...a),
    updateMember: (...a: unknown[]) => updateMember(...a),
    recordStatusChange: (...a: unknown[]) => recordStatusChange(...a),
  };
});

vi.mock('@helpers/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@helpers/settings')>();
  return {
    ...actual,
    getSetting: (...a: unknown[]) => getSettingMock(...a),
  };
});

const { activateMembershipForInvoice, startTerm } =
  await import('@modules/billing/membershipActivation');

const PARAMS = {
  invoiceId: 42n,
  memberId: 5n,
  invoiceNumber: 'IN202603001',
  changedByAdminId: 9n,
};

const termFindMany = vi.fn();
const termUpdateMany = vi.fn();
const termUpdate = vi.fn();
const memberUpdate = vi.fn();
const tx = {
  membershipTerm: { findMany: termFindMany, updateMany: termUpdateMany, update: termUpdate },
  member: { update: memberUpdate },
};
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const TODAY = day('2027-03-20');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = () => activateMembershipForInvoice(tx as any, { ...PARAMS, today: TODAY });

describe('activateMembershipForInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findMemberById.mockResolvedValue({ id: 5n, status: 'PENDING', joined_on: null });
    updateMember.mockResolvedValue({ id: 5n, status: 'ACTIVE' });
    getSettingMock.mockResolvedValue(null);
  });

  it('activates a first term that has started and points the member at it', async () => {
    termFindMany.mockResolvedValue([{ id: 11n, valid_from: day('2027-03-01') }]);
    await run();
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 11n }, data: { status: 'ACTIVE' } });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 5n },
      data: { current_term_id: 11n },
    });
    expect(updateMember).toHaveBeenCalledWith(
      tx,
      5n,
      expect.objectContaining({ status: 'ACTIVE' }),
    );
  });

  it('holds an early renewal payment as PAID_UPCOMING and leaves the member alone', async () => {
    findMemberById.mockResolvedValue({ id: 5n, status: 'ACTIVE', joined_on: day('2026-04-01') });
    termFindMany.mockResolvedValue([{ id: 12n, valid_from: day('2027-04-01') }]);
    await run();
    expect(termUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: [12n] } },
      data: { status: 'PAID_UPCOMING' },
    });
    expect(termUpdate).not.toHaveBeenCalled();
    expect(updateMember).not.toHaveBeenCalled();
  });

  it('closes the ended term before activating a renewal paid in grace', async () => {
    findMemberById.mockResolvedValue({ id: 5n, status: 'ACTIVE', joined_on: day('2026-04-01') });
    termFindMany.mockResolvedValue([{ id: 12n, valid_from: day('2027-03-12') }]);
    await run();
    expect(termUpdateMany).toHaveBeenCalledWith({
      where: { member_id: 5n, status: 'ACTIVE', id: { not: 12n } },
      data: { status: 'EXPIRED' },
    });
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 12n }, data: { status: 'ACTIVE' } });
    expect(updateMember).not.toHaveBeenCalled();
  });

  it('brings an EXPIRED member back when their renewal is paid', async () => {
    findMemberById.mockResolvedValue({ id: 5n, status: 'EXPIRED', joined_on: day('2026-04-01') });
    termFindMany.mockResolvedValue([{ id: 12n, valid_from: day('2027-02-01') }]);
    await run();
    expect(updateMember).toHaveBeenCalledWith(tx, 5n, { status: 'ACTIVE' });
    expect(recordStatusChange).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        from_status: 'EXPIRED',
        to_status: 'ACTIVE',
        reason: 'Renewal invoice IN202603001 paid',
      }),
    );
  });

  it('does nothing to the member for an invoice with no pending term (event invoice)', async () => {
    findMemberById.mockResolvedValue({ id: 5n, status: 'EXPIRED', joined_on: day('2026-04-01') });
    termFindMany.mockResolvedValue([]);
    await run();
    expect(updateMember).not.toHaveBeenCalled();
  });
});

describe('activateMembershipForInvoice — first-term re-dating (M6, decided 2026-09-11)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runOn = (today: Date) => activateMembershipForInvoice(tx as any, { ...PARAMS, today });

  beforeEach(() => {
    vi.clearAllMocks();
    findMemberById.mockResolvedValue({ id: 5n, status: 'PENDING', joined_on: null });
    updateMember.mockResolvedValue({ id: 5n, status: 'ACTIVE' });
  });

  it('re-dates a NEW term on a monthly plan (basis term) to start the day it is paid', async () => {
    getSettingMock.mockResolvedValue('term');
    termFindMany.mockResolvedValue([
      {
        id: 11n,
        term_type: 'NEW',
        valid_from: day('2026-09-09'),
        valid_till: day('2026-10-08'),
        fee_plan_id: 7n,
        fee_plan: { billing_cycle: 'MONTHLY' },
      },
    ]);

    await runOn(day('2026-09-10'));

    expect(termUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: 11n },
      data: expect.objectContaining({
        valid_from: expect.any(Date),
        valid_till: expect.any(Date),
      }),
    });
    const [{ data }] = termUpdate.mock.calls[0]!;
    expect((data.valid_from as Date).toISOString().slice(0, 10)).toBe('2026-09-10');
    expect((data.valid_till as Date).toISOString().slice(0, 10)).toBe('2026-10-09');

    expect(termUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: 11n },
      data: { status: 'ACTIVE' },
    });
  });

  it('re-dates a NEW term under financial_year basis, keeping valid_till', async () => {
    getSettingMock.mockResolvedValue('financial_year');
    termFindMany.mockResolvedValue([
      {
        id: 11n,
        term_type: 'NEW',
        valid_from: day('2026-09-09'),
        valid_till: day('2027-03-31'),
        fee_plan_id: 7n,
        fee_plan: { billing_cycle: 'YEARLY' },
      },
    ]);

    await runOn(day('2026-09-20'));

    const [{ data }] = termUpdate.mock.calls[0]!;
    expect((data.valid_from as Date).toISOString().slice(0, 10)).toBe('2026-09-20');
    expect((data.valid_till as Date).toISOString().slice(0, 10)).toBe('2027-03-31');
  });

  it('falls through to the day-shift when a financial_year term is paid on its own last day', async () => {
    getSettingMock.mockResolvedValue('financial_year');
    termFindMany.mockResolvedValue([
      {
        id: 11n,
        term_type: 'NEW',
        valid_from: day('2027-03-01'),
        valid_till: day('2027-03-31'),
        fee_plan_id: 7n,
        fee_plan: { billing_cycle: 'YEARLY' },
      },
    ]);

    // today === valid_till: keeping valid_till unchanged would make valid_from === valid_till,
    // violating the DB CHECK MembershipTerms_span_ordered (valid_till > valid_from). Must fall
    // through to the day-shift branch instead, which always preserves a positive span.
    await runOn(day('2027-03-31'));

    const [{ data }] = termUpdate.mock.calls[0]!;
    const validFrom = data.valid_from as Date;
    const validTill = data.valid_till as Date;
    // shift = daysBetween(2027-03-01, 2027-03-31) = 30 days; addDays(2027-03-31, 30) = 2027-04-30.
    expect(validFrom.toISOString().slice(0, 10)).toBe('2027-03-31');
    expect(validTill.toISOString().slice(0, 10)).toBe('2027-04-30');
    expect(validTill.getTime()).toBeGreaterThan(validFrom.getTime());
  });

  it('shifts a NEW term with no fee plan by the days it was paid late', async () => {
    getSettingMock.mockResolvedValue('term');
    termFindMany.mockResolvedValue([
      {
        id: 11n,
        term_type: 'NEW',
        valid_from: day('2026-09-09'),
        valid_till: day('2026-10-08'),
        fee_plan_id: null,
        fee_plan: null,
      },
    ]);

    await runOn(day('2026-09-12'));

    const [{ data }] = termUpdate.mock.calls[0]!;
    expect((data.valid_from as Date).toISOString().slice(0, 10)).toBe('2026-09-12');
    expect((data.valid_till as Date).toISOString().slice(0, 10)).toBe('2026-10-11');
  });

  it('does not re-date a RENEWAL term paid on or after its start', async () => {
    findMemberById.mockResolvedValue({ id: 5n, status: 'ACTIVE', joined_on: day('2025-09-09') });
    getSettingMock.mockResolvedValue('term');
    termFindMany.mockResolvedValue([
      {
        id: 12n,
        term_type: 'RENEWAL',
        valid_from: day('2026-09-09'),
        valid_till: day('2026-10-08'),
        fee_plan_id: 7n,
        fee_plan: { billing_cycle: 'MONTHLY' },
      },
    ]);

    await runOn(day('2026-09-12'));

    expect(termUpdate).toHaveBeenCalledTimes(1);
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 12n }, data: { status: 'ACTIVE' } });
  });

  it('does not re-date a NEW term whose valid_from already equals today', async () => {
    getSettingMock.mockResolvedValue('term');
    termFindMany.mockResolvedValue([
      {
        id: 11n,
        term_type: 'NEW',
        valid_from: day('2026-09-12'),
        valid_till: day('2026-10-11'),
        fee_plan_id: 7n,
        fee_plan: { billing_cycle: 'MONTHLY' },
      },
    ]);

    await runOn(day('2026-09-12'));

    expect(termUpdate).toHaveBeenCalledTimes(1);
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 11n }, data: { status: 'ACTIVE' } });
  });
});

describe('startTerm', () => {
  it('closes the member other active term, activates this one, then points current_term_id at it, in that order', async () => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startTerm(tx as any, 5n, 11n);

    expect(termUpdateMany).toHaveBeenCalledWith({
      where: { member_id: 5n, status: 'ACTIVE', id: { not: 11n } },
      data: { status: 'EXPIRED' },
    });
    expect(termUpdate).toHaveBeenCalledWith({ where: { id: 11n }, data: { status: 'ACTIVE' } });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: { id: 5n },
      data: { current_term_id: 11n },
    });

    const updateManyOrder = termUpdateMany.mock.invocationCallOrder[0];
    const updateOrder = termUpdate.mock.invocationCallOrder[0];
    const memberUpdateOrder = memberUpdate.mock.invocationCallOrder[0];
    expect(updateManyOrder).toBeLessThan(updateOrder);
    expect(updateOrder).toBeLessThan(memberUpdateOrder);
  });
});
