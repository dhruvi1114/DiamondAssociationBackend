/* eslint-disable no-console */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadEnvironmentFiles } from '../src/config/loadEnv';

/**
 * ADR-013 gate: fail the build if any table or column in `public` lacks a
 * database comment.
 *
 * Prisma does not propagate `///` doc-comments to PostgreSQL, so without this
 * check the schema is self-documenting in TypeScript and bare in `\d+`,
 * pgAdmin, DBeaver and every generated ERD. Runs in husky pre-push and in every
 * module's self-test; exits 1 on the first gap.
 *
 *   npm run db:check-comments
 */

loadEnvironmentFiles(path.join(__dirname, '..'));

interface Gap {
  table_name: string;
  column_name: string;
  missing: string;
}

const prisma = new PrismaClient({ log: ['error'] });

/** The coverage query from database-design.md §I, verbatim in intent. */
const findGaps = (): Promise<Gap[]> =>
  prisma.$queryRaw<Gap[]>`
    SELECT c.relname   AS table_name,
           a.attname   AS column_name,
           CASE
             WHEN obj_description(c.oid, 'pg_class') IS NULL THEN 'TABLE + COLUMN'
             ELSE 'COLUMN'
           END         AS missing
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname <> '_prisma_migrations'
      AND (col_description(c.oid, a.attnum) IS NULL
           OR obj_description(c.oid, 'pg_class') IS NULL)
    ORDER BY c.relname, a.attnum
  `;

const countCovered = (): Promise<{ tables: bigint; columns: bigint }[]> =>
  prisma.$queryRaw<{ tables: bigint; columns: bigint }[]>`
    SELECT COUNT(DISTINCT c.relname)::bigint AS tables,
           COUNT(*)::bigint                  AS columns
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname <> '_prisma_migrations'
  `;

const main = async (): Promise<void> => {
  const [gaps, totals] = await Promise.all([findGaps(), countCovered()]);
  const { tables, columns } = totals[0] ?? { tables: 0n, columns: 0n };

  if (gaps.length === 0) {
    console.log(
      `db:check-comments OK — ${tables} tables / ${columns} columns in "public", every one commented.`,
    );
    return;
  }

  console.error(
    `db:check-comments FAILED — ${gaps.length} column(s) without a COMMENT ON (ADR-013).\n`,
  );

  const byTable = new Map<string, Gap[]>();

  for (const gap of gaps) {
    const entries = byTable.get(gap.table_name) ?? [];
    entries.push(gap);
    byTable.set(gap.table_name, entries);
  }

  for (const [table, entries] of byTable) {
    const tableMissing = entries.some((entry) => entry.missing === 'TABLE + COLUMN');
    console.error(`  ${table}${tableMissing ? '  (table comment missing too)' : ''}`);
    entries.forEach((entry) => console.error(`    - ${entry.column_name}`));
  }

  console.error(
    [
      '',
      'Fix: add the `///` doc-comment in prisma/schema/*.prisma, then regenerate the',
      'COMMENT block into the migration that CREATES the object:',
      '',
      '  npx tsx scripts/emit-db-comments.ts <Table> [<Table> …]',
      '',
      'Never add comments in a follow-up migration (migration-strategy.md).',
    ].join('\n'),
  );

  process.exitCode = 1;
};

main()
  .catch((error: unknown) => {
    console.error(
      'db:check-comments could not run:',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
