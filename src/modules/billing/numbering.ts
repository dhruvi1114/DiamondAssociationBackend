import type { Prisma } from '@prisma/client';

/**
 * Payment and receipt numbering.
 *
 * Shared by the membership payment path and the event one so both use the same
 * scheme. Two schemes on the same prefix — one counting rows, one drawing from a
 * sequence — would eventually produce the same number twice and fail on the
 * unique index.
 *
 * The count is taken inside the payment transaction. It is not collision-proof
 * under true concurrency, but the unique index is: a loser gets a unique
 * violation rather than a duplicate number.
 */

const quarterPrefix = (letters: string, on: Date): string =>
  `${letters}${on.getUTCFullYear()}${String(Math.floor(on.getUTCMonth() / 3) + 1).padStart(2, '0')}`;

/** `PY` + year + calendar quarter + 3-digit sequence, e.g. PY202603001. */
export const nextPaymentNumber = async (
  tx: Prisma.TransactionClient,
  on: Date = new Date(),
): Promise<string> => {
  const prefix = quarterPrefix('PY', on);
  const count = await tx.payment.count({ where: { payment_number: { startsWith: prefix } } });

  return `${prefix}${String(count + 1).padStart(3, '0')}`;
};

/** `RC` + year + calendar quarter + 3-digit sequence, e.g. RC202603001. */
export const nextReceiptNumber = async (
  tx: Prisma.TransactionClient,
  on: Date = new Date(),
): Promise<string> => {
  const prefix = quarterPrefix('RC', on);
  const count = await tx.receipt.count({ where: { receipt_number: { startsWith: prefix } } });

  return `${prefix}${String(count + 1).padStart(3, '0')}`;
};
