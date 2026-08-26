import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { loadEnvironmentFiles } from './src/config/loadEnv';

/**
 * Prisma CLI configuration.
 *
 * Two things it exists to pin:
 *  1. `schema` points at the multi-file folder `prisma/schema/`
 *     (migration-strategy.md §"Schema file organisation").
 *  2. `migrations.path` keeps the history in `prisma/migrations/` — the layout
 *     in architecture.md §2 and, more importantly, where the already-applied
 *     baseline `20260225095547` lives. Prisma's default for a schema *folder*
 *     is `prisma/schema/migrations/`, which would orphan that baseline and
 *     silently start a second migration history.
 *
 * A config file also means Prisma stops auto-loading `.env`, so the CLI reuses
 * the application's own loader — same precedence, same blank-value handling.
 * Without it `DATABASE_URL` would be undefined for every CLI command.
 */
loadEnvironmentFiles(__dirname);

export default defineConfig({
  schema: path.join('prisma', 'schema'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
