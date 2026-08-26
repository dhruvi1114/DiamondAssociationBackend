import type { Db } from '@db/prisma';
import { Prisma } from '@prisma/client';
import { getSetting, SETTING_KEYS } from '@helpers/settings';

/**
 * Human-facing document numbers — invoice, receipt, payment, member code,
 * application number (ADR-007).
 *
 * Guarantees:
 *  - **Never duplicates.** Allocation happens inside the caller's transaction,
 *    serialised per scope by a Postgres advisory lock, and every column that
 *    stores one of these carries a UNIQUE constraint as a second line of
 *    defence.
 *  - **Never reuses.** A number handed out is spent, even if the surrounding
 *    transaction rolls back.
 *
 * Not guaranteed: an unbroken run with no gaps. A rolled-back transaction
 * consumes its number, exactly like `nextval`. If OQ-8 comes back requiring
 * gapless statutory numbering, this becomes a counter table read with
 * `SELECT … FOR UPDATE` inside the same transaction — the signature below does
 * not change, only the body.
 *
 * Formats are A-12 defaults and are **pending OQ-8**; callers pass the parts
 * rather than this module deciding them.
 */

export interface DocumentNumberOptions {
  /** Document family, e.g. `INV`, `RCP`, `PAY`. Becomes the leading segment. */
  prefix: string;
  /** Period segment, e.g. `2026-27`. Omit for a series that never resets. */
  period?: string;
  /** Zero-padded width of the counter. A-12 uses 5 for invoices, 4 for members. */
  width?: number;
  /** Segment separator. A-12 uses `/`. */
  separator?: string;
}

const DEFAULT_WIDTH = 5;
const DEFAULT_SEPARATOR = '/';

/** Stable 64-bit key for `pg_advisory_xact_lock`, derived from the scope name. */
const advisoryKey = (scope: string): bigint => {
  // FNV-1a 64-bit, then folded into the signed range Postgres accepts.
  let hash = 0xcbf29ce484222325n;

  for (const char of Buffer.from(scope, 'utf8')) {
    hash ^= BigInt(char);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }

  return BigInt.asIntN(64, hash);
};

const sequenceName = (scope: string): string =>
  `docseq_${scope.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 63);

/**
 * Indian financial year label for a date: 1 April – 31 March, rendered
 * `2026-27`. Used for the `YYYY-YY` segment in A-12's formats.
 */
export const financialYear = (date: Date = new Date()): string => {
  const year = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? year : year - 1;

  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

/**
 * Allocate the next number in a series.
 *
 * MUST be called with the caller's transaction client so the advisory lock is
 * held for the life of that transaction — that is what stops two concurrent
 * approvals from racing on the same series.
 *
 *   await prisma.$transaction(async (tx) => {
 *     const number = await generateDocumentNumber(tx, {
 *       prefix: 'INV',
 *       period: financialYear(),
 *     });                                       // INV/2026-27/00001
 *     await tx.invoice.create({ data: { invoice_number: number, … } });
 *   });
 */
export const generateDocumentNumber = async (
  db: Db,
  options: DocumentNumberOptions,
): Promise<string> => {
  const { prefix, period, width = DEFAULT_WIDTH, separator = DEFAULT_SEPARATOR } = options;

  const scope = period ? `${prefix}_${period}` : prefix;
  const sequence = sequenceName(scope);

  // Serialise concurrent first-use of this scope: two transactions that both
  // find the sequence missing would otherwise race on CREATE SEQUENCE.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${advisoryKey(scope)}::bigint)`;

  // Identifier, not a value — it cannot be a bind parameter, so it is built
  // from the sanitised `sequenceName` above and never from caller input.
  await db.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS "${sequence}" AS BIGINT START 1`);

  const rows = await db.$queryRaw<{ value: bigint }[]>(
    Prisma.sql`SELECT nextval(${sequence}::regclass)::bigint AS value`,
  );

  const next = rows[0]?.value ?? 1n;
  const counter = next.toString().padStart(width, '0');

  return [prefix, period, counter].filter(Boolean).join(separator);
};

/* -------------------------------------------------------------------------- */
/* Invoice numbering (OQ-8, answered 2026-08-13)                               */
/* -------------------------------------------------------------------------- */

/**
 * Calendar quarter, 1–4. Jul–Sep is Q3, which is what the client's example
 * (`IN202603001`, issued in August 2026) encodes.
 *
 * If the federation later means the Indian **financial** quarter — Apr–Jun as
 * Q1 — this one function changes and the format stays identical. Recorded here
 * rather than assumed silently, because the two disagree for nine months of
 * every year.
 */
export const calendarQuarter = (on: Date): number => Math.floor(on.getUTCMonth() / 3) + 1;

/** Prefix used when the setting is missing or unusable — the format the client signed off. */
const DEFAULT_INVOICE_PREFIX = 'IN';

/**
 * The configured invoice prefix, defended.
 *
 * It is concatenated straight into a document number and then into a sequence
 * NAME, so an unexpected value would either produce an invoice number that does
 * not match the agreed format or a nonsense sequence. The settings API already
 * enforces this shape; re-checking here means a row edited directly in the
 * database cannot reach `CREATE SEQUENCE`.
 */
const invoicePrefix = async (): Promise<string> => {
  const raw = (await getSetting(SETTING_KEYS.INVOICE_PREFIX))?.trim();

  return raw && /^[A-Z0-9]{1,10}$/.test(raw) ? raw : DEFAULT_INVOICE_PREFIX;
};

/**
 * `IN` + year + quarter + sequence, e.g. **IN202603001**.
 *
 * The sequence restarts each quarter, so the period segment is what makes the
 * number unique — `IN2026030 01` in Q3 and `IN202604001` in Q4 are different
 * invoices, and both are the first of their quarter.
 *
 * Three digits allows 999 invoices per quarter. It is a padding width, not a
 * ceiling: the 1000th widens to four digits rather than colliding or throwing.
 * A federation issuing 999 invoices in a quarter has outgrown this format and
 * should be told, not silently truncated.
 *
 * The `IN` comes from `billing.invoice_prefix`. Because the prefix is part of
 * the sequence scope, changing it starts a fresh series rather than renumbering
 * anything: invoices already issued keep the number they were issued under, and
 * the new prefix begins at `001` for the current quarter. That is the only safe
 * behaviour — an issued invoice number is a statutory reference and must never
 * change under a member's feet.
 */
export const allocateInvoiceNumber = async (
  db: Db,
  issuedOn: Date = new Date(),
): Promise<string> => {
  const year = issuedOn.getUTCFullYear();
  const quarter = String(calendarQuarter(issuedOn)).padStart(2, '0');

  return generateDocumentNumber(db, {
    prefix: await invoicePrefix(),
    period: `${year}${quarter}`,
    width: 3,
    // No separators: the client's format is one continuous token.
    separator: '',
  });
};
