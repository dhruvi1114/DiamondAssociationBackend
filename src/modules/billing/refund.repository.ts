import { Prisma } from '@prisma/client';

import { prisma } from '@db/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Everything the queue shows about one refund.
 *
 * Who is owed the money is two joins away — a refund hangs off a payment, and
 * the payer is on the payment. It is included rather than looked up per row
 * because a list of refund numbers with no names attached cannot be worked
 * through: the first question about any row is whose money it is.
 */
const actor = { select: { id: true, full_name: true } } as const;

export const refundInclude = {
  /*
    The three staff accounts a refund names, resolved here rather than by the
    screen. A list of admin ids is not something anybody can read, and looking
    each one up per row is a query per row.
  */
  requested_by: actor,
  approved_by: actor,
  finalised_by: actor,
  payment: {
    select: {
      id: true,
      amount: true,
      invoice: { select: { id: true, invoice_number: true } },
      member: {
        select: {
          id: true,
          company_name: true,
          /*
            Where a refund email goes for a member. The primary contact, not a
            login: every company has one — signup creates it now — and it is the
            address the association already writes to about the membership.
          */
          contacts: {
            where: { is_primary: true, deletedAt: null },
            select: { email: true },
            take: 1,
          },
        },
      },
      guest_registrant: {
        select: { id: true, full_name: true, company_name: true, email: true },
      },
    },
  },
} satisfies Prisma.RefundInclude;

export type RefundRow = Prisma.RefundGetPayload<{ include: typeof refundInclude }>;

export const listRefunds = (
  db: Db,
  where: Prisma.RefundWhereInput,
  skip: number,
  take: number,
): Promise<RefundRow[]> =>
  db.refund.findMany({
    where,
    include: refundInclude,
    // Newest first: a refund queue is worked from the top, and the oldest
    // outstanding row is found by filtering to REQUESTED, not by scrolling.
    orderBy: { id: 'desc' },
    skip,
    take,
  });

export const countRefunds = (db: Db, where: Prisma.RefundWhereInput): Promise<number> =>
  db.refund.count({ where });

export const findRefund = (db: Db, id: bigint): Promise<RefundRow | null> =>
  db.refund.findFirst({ where: { id }, include: refundInclude });

export const updateRefund = (db: Db, id: bigint, data: Prisma.RefundUpdateInput) =>
  db.refund.update({ where: { id }, data });
