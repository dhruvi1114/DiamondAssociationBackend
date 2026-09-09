import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rules that cost money if they are wrong (M2 redesign).
 *
 * The database enforces overlap and completeness on its own — those are proven by the
 * constraints, not here. What is worth testing in the service is the decision it makes BEFORE
 * writing: whether a save may write a price in place or must close it and publish a replacement,
 * and whether it refuses to guess who a price rise reaches.
 */

const feePlanFindFirst = vi.fn();
const feePlanFindMany = vi.fn();
const feePlanCreate = vi.fn();
const feePlanUpdate = vi.fn();
const structureFindFirst = vi.fn();
const structureCreate = vi.fn();
const structureUpdate = vi.fn();
const termGroupBy = vi.fn();
const invoiceItemGroupBy = vi.fn();
const auditCreate = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    feePlan: {
      findFirst: (...a: unknown[]) => feePlanFindFirst(...a),
      findMany: (...a: unknown[]) => feePlanFindMany(...a),
      create: (...a: unknown[]) => feePlanCreate(...a),
      update: (...a: unknown[]) => feePlanUpdate(...a),
    },
    feePlanStructure: {
      findFirst: (...a: unknown[]) => structureFindFirst(...a),
      update: (...a: unknown[]) => structureUpdate(...a),
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    membershipTerm: { groupBy: (...a: unknown[]) => termGroupBy(...a) },
    invoiceItem: { groupBy: (...a: unknown[]) => invoiceItemGroupBy(...a) },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        feePlan: {
          create: (...a: unknown[]) => feePlanCreate(...a),
          update: (...a: unknown[]) => feePlanUpdate(...a),
        },
        feePlanStructure: {
          create: (...a: unknown[]) => structureCreate(...a),
          update: (...a: unknown[]) => structureUpdate(...a),
        },
        auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
      }),
  },
}));

const { createStructure, updateStructure, CYCLE_MONTHS } =
  await import('@modules/masters/masters.feePlans.service');

const actor = { id: 1n, ip: null, userAgent: null, requestId: null };

/** A live yearly plan at 25,000 / 20,000, held by structure 1. */
const yearly = {
  id: 43n,
  structure_id: 1n,
  billing_cycle: 'YEARLY' as const,
  name: 'Best Value',
  amount: new Prisma.Decimal('25000.00'),
  renewal_amount: new Prisma.Decimal('20000.00'),
  tax_rate: new Prisma.Decimal('18.00'),
  currency: 'INR',
  effective_from: new Date('2026-04-01'),
  effective_to: null,
  price_scope: 'ALL_MEMBERS' as const,
  is_active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const submit = (overrides: Record<string, unknown> = {}) => ({
  name: 'Membership 2026',
  effective_from: '2027-04-01',
  plans: [
    {
      billing_cycle: 'YEARLY' as const,
      name: 'Best Value',
      amount: '28000.00',
      renewal_amount: '22000.00',
      tax_rate: '18.00',
    },
  ],
  ...overrides,
});

/** Nobody else holds a live YEARLY price, so the D-3 clash check passes. */
const noRivals = () => feePlanFindMany.mockResolvedValue([]);

const billed = (isBilled: boolean, members = 12) => {
  termGroupBy.mockResolvedValue(
    members > 0 ? [{ fee_plan_id: 43n, _count: { _all: members } }] : [],
  );
  invoiceItemGroupBy.mockResolvedValue(isBilled ? [{ fee_plan_id: 43n, _count: { _all: 3 } }] : []);
};

beforeEach(() => {
  vi.clearAllMocks();
  structureFindFirst.mockResolvedValue({
    id: 1n,
    name: 'Membership 2026',
    is_active: true,
    plans: [yearly],
  });
  feePlanCreate.mockResolvedValue({ ...yearly, id: 58n });
  feePlanUpdate.mockResolvedValue(yearly);
  structureCreate.mockResolvedValue({ id: 9n });
  structureUpdate.mockResolvedValue({ id: 1n });
  auditCreate.mockResolvedValue({});
  noRivals();
});

describe('fee plan cycles', () => {
  it('derives months from the cycle rather than storing them twice', () => {
    expect(CYCLE_MONTHS).toEqual({ MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 });
  });
});

describe('changing a price that has been invoiced', () => {
  it('refuses to guess who the new price reaches', async () => {
    billed(true);

    await expect(updateStructure(1n, submit() as never, actor)).rejects.toMatchObject({
      messageKey: 'masters.feePlanScopeRequired',
    });

    expect(feePlanCreate).not.toHaveBeenCalled();
    expect(feePlanUpdate).not.toHaveBeenCalled();
  });

  it('closes the old price and publishes a replacement, never overwriting', async () => {
    billed(true);

    await updateStructure(1n, submit({ price_scope: 'ALL_MEMBERS' }) as never, actor);

    // The old row is closed the day before the new one starts — not amended.
    expect(feePlanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 43n },
        data: { is_active: false, effective_to: new Date('2027-03-31') },
      }),
    );

    const created = feePlanCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(created.data).toMatchObject({
      billing_cycle: 'YEARLY',
      price_scope: 'ALL_MEMBERS',
      effective_from: new Date('2027-04-01'),
    });
  });

  it('records the scope the admin actually chose, not a default', async () => {
    billed(true);

    await updateStructure(1n, submit({ price_scope: 'NEW_MEMBERS_ONLY' }) as never, actor);

    const created = feePlanCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(created.data.price_scope).toBe('NEW_MEMBERS_ONLY');
  });

  it('refuses a replacement that would start before the price it replaces began', async () => {
    billed(true);

    await expect(
      updateStructure(
        1n,
        submit({ effective_from: '2026-01-01', price_scope: 'ALL_MEMBERS' }) as never,
        actor,
      ),
    ).rejects.toMatchObject({ messageKey: 'masters.feePlanEffectiveFromTooEarly' });
  });
});

describe('changing a price nobody has paid', () => {
  it('writes it in place, keeping no version', async () => {
    billed(false, 0);

    await updateStructure(1n, submit() as never, actor);

    expect(feePlanCreate).not.toHaveBeenCalled();
    const call = feePlanUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(call.data).toMatchObject({ name: 'Best Value' });
    expect(call.data.is_active).toBeUndefined();
  });
});

describe('unpublishing a cycle', () => {
  it('closes the plan rather than deleting it, so it can still bill the members on it', async () => {
    billed(true);

    await updateStructure(
      1n,
      {
        name: 'Membership 2026',
        effective_from: '2027-04-01',
        plans: [
          {
            billing_cycle: 'MONTHLY',
            name: 'Starter',
            amount: '3000.00',
            renewal_amount: '2500.00',
            tax_rate: '18.00',
          },
        ],
      } as never,
      actor,
    );

    expect(feePlanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 43n },
        data: { is_active: false, effective_to: new Date('2027-03-31') },
      }),
    );
  });
});

/**
 * The retire-then-create path.
 *
 * Under D-3 a live structure blocks a new one, so this is how a price normally changes: close the
 * old list, publish its replacement. The scope question therefore arises on CREATE, and it was
 * once dropped on the way to the service — the UI asked, the backend defaulted to ALL_MEMBERS,
 * and every member an admin had chosen to freeze was moved anyway. These tests exist to keep that
 * shut.
 */
describe('publishing a replacement for a retired list', () => {
  const retiredYearly = { ...yearly, id: 43n, is_active: false };

  const newList = (overrides: Record<string, unknown> = {}) => ({
    name: 'Membership 2027',
    effective_from: '2027-04-01',
    plans: [
      {
        billing_cycle: 'YEARLY' as const,
        name: 'Best Value',
        amount: '28000.00',
        renewal_amount: '22000.00',
        tax_rate: '18.00',
      },
    ],
    ...overrides,
  });

  beforeEach(() => {
    // No live rival (D-3 satisfied), but a retired plan still holding 12 members.
    feePlanFindMany.mockImplementation((args: { where?: { is_active?: boolean } }) =>
      Promise.resolve(args?.where?.is_active === false ? [retiredYearly] : []),
    );
    termGroupBy.mockResolvedValue([{ fee_plan_id: 43n, _count: { _all: 12 } }]);
    invoiceItemGroupBy.mockResolvedValue([{ fee_plan_id: 43n, _count: { _all: 12 } }]);
    feePlanFindFirst.mockResolvedValue({ ...yearly, id: 58n });
    structureFindFirst.mockResolvedValue({
      id: 9n,
      name: 'Membership 2027',
      is_active: true,
      plans: [],
    });
  });

  it('refuses to publish over stranded members without an answer', async () => {
    await expect(createStructure(newList() as never, actor)).rejects.toMatchObject({
      messageKey: 'masters.feePlanScopeRequired',
    });
  });

  it('writes NEW_MEMBERS_ONLY when that is what the admin chose', async () => {
    await createStructure(newList({ price_scope: 'NEW_MEMBERS_ONLY' }) as never, actor);

    const created = feePlanCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(created.data.price_scope).toBe('NEW_MEMBERS_ONLY');
  });

  it('writes ALL_MEMBERS when that is what the admin chose', async () => {
    await createStructure(newList({ price_scope: 'ALL_MEMBERS' }) as never, actor);

    const created = feePlanCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(created.data.price_scope).toBe('ALL_MEMBERS');
  });

  it('does not ask when nobody is stranded', async () => {
    termGroupBy.mockResolvedValue([]);
    invoiceItemGroupBy.mockResolvedValue([]);

    await expect(createStructure(newList() as never, actor)).resolves.toBeDefined();
  });
});
