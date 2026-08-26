/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Emit the `COMMENT ON TABLE` / `COMMENT ON COLUMN` block for a migration,
 * generated from the `///` doc-comments in `prisma/schema/*.prisma`.
 *
 * ADR-013 requires the Prisma doc-comment and the SQL comment to say the same
 * thing, with the `///` version as the source. Typing the block by hand makes
 * that a promise; generating it makes it a fact.
 *
 * Usage:
 *   npx tsx scripts/emit-db-comments.ts                    # every model
 *   npx tsx scripts/emit-db-comments.ts Users AdminUsers   # named tables only
 *
 * Paste the output at the end of the migration that CREATES those objects —
 * never into a follow-up "add comments" migration (migration-strategy.md).
 */

const SCHEMA_DIR = path.join(__dirname, '..', 'prisma', 'schema');

interface ColumnComment {
  column: string;
  comment: string;
}

interface TableComment {
  table: string;
  comment: string;
  columns: ColumnComment[];
}

const sqlQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Collapse a `///` run into one line — SQL comments are single-line strings. */
const joinDocLines = (lines: string[]): string =>
  lines
    .map((line) => line.replace(/^\s*\/\/\/\s?/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ');

const parseSchema = (source: string, modelNames: Set<string>): TableComment[] => {
  const lines = source.split('\n');
  const tables: TableComment[] = [];

  let pendingDoc: string[] = [];
  let current: TableComment | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('///')) {
      pendingDoc.push(rawLine);
      continue;
    }

    // --- entering a model ------------------------------------------------
    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);

    if (modelMatch) {
      current = {
        // Overwritten by @@map below; a model without @@map keeps its own name.
        table: modelMatch[1],
        comment: joinDocLines(pendingDoc),
        columns: [],
      };
      pendingDoc = [];
      continue;
    }

    if (!current) {
      // Enums and everything else outside a model: comments on a Postgres enum
      // TYPE are not covered by the ADR-013 coverage query (it checks relations
      // only), so the `///` text stays schema-side documentation.
      pendingDoc = [];
      continue;
    }

    if (line === '}') {
      tables.push(current);
      current = null;
      pendingDoc = [];
      continue;
    }

    const mapMatch = /^@@map\("([^"]+)"\)/.exec(line);

    if (mapMatch) {
      current.table = mapMatch[1];
      pendingDoc = [];
      continue;
    }

    if (line.startsWith('@@') || line.length === 0) {
      pendingDoc = [];
      continue;
    }

    // --- a field ----------------------------------------------------------
    const fieldMatch = /^(\w+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?(.*)$/.exec(line);

    if (!fieldMatch) {
      pendingDoc = [];
      continue;
    }

    const [, fieldName, fieldType, isList, , attributes] = fieldMatch;

    // Relation navigation fields are not columns. The scalar FK field that
    // backs them (`user_id`) is declared separately and IS a column.
    //
    // The test is "is this type a model?", NOT "is this a list?". An earlier
    // version skipped every list to filter out relation arrays (`tiers Tier[]`)
    // and silently dropped scalar arrays too — `allowed_mime String[]` is a real
    // column and shipped without a comment. `db:check-comments` caught it, which
    // is the only reason this is a five-minute bug instead of a permanent hole.
    if (modelNames.has(fieldType)) {
      pendingDoc = [];
      continue;
    }

    void isList;

    const columnMapMatch = /@map\("([^"]+)"\)/.exec(attributes);
    const column = columnMapMatch ? columnMapMatch[1] : fieldName;
    const comment = joinDocLines(pendingDoc);

    current.columns.push({ column, comment });
    pendingDoc = [];
  }

  return tables;
};

const main = (): void => {
  const files = fs
    .readdirSync(SCHEMA_DIR)
    .filter((file) => file.endsWith('.prisma'))
    .sort();

  const sources = files.map((file) => fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
  const joined = sources.join('\n');

  const modelNames = new Set<string>(
    [...joined.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]),
  );

  const tables = sources.flatMap((source) => parseSchema(source, modelNames));

  const wanted = process.argv.slice(2);
  const selected =
    wanted.length > 0 ? tables.filter((table) => wanted.includes(table.table)) : tables;

  if (selected.length === 0) {
    console.error(`No models matched. Known tables: ${tables.map((t) => t.table).join(', ')}`);
    process.exit(1);
  }

  const missing: string[] = [];
  const out: string[] = [];

  out.push('-- ============================================================================');
  out.push('-- Table & column comments (ADR-013 / database-design.md §I)');
  out.push('-- Generated from the /// doc-comments in prisma/schema/*.prisma by');
  out.push('--   npx tsx scripts/emit-db-comments.ts');
  out.push('-- Keep both sides in step: regenerate rather than editing this block by hand.');
  out.push('-- ============================================================================');

  for (const table of selected) {
    if (!table.comment) {
      missing.push(`TABLE ${table.table}`);
    }

    out.push('');
    out.push(`COMMENT ON TABLE "${table.table}" IS ${sqlQuote(table.comment)};`);

    for (const column of table.columns) {
      if (!column.comment) {
        missing.push(`COLUMN ${table.table}.${column.column}`);
      }

      out.push(
        `COMMENT ON COLUMN "${table.table}"."${column.column}" IS ${sqlQuote(column.comment)};`,
      );
    }
  }

  if (missing.length > 0) {
    console.error('Missing /// doc-comments — fix the schema before generating SQL:');
    missing.forEach((entry) => console.error(`  - ${entry}`));
    process.exit(1);
  }

  console.log(out.join('\n'));
};

main();
