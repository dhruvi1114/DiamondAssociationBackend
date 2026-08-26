import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { environment } from '@config/config';
import { MSG_KEYS, RES_STATUS } from '@constant/message.constant';
import { prisma } from '@db/prisma';
import { getStorage } from '@helpers/storage';
import { logger } from '@logger/logger';
import { handleApiResponse } from '@utils/handleResponse';

export const healthRouter = Router();

type DependencyState = 'up' | 'down';

const packageVersion = (): string => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8');

    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
};

const version = packageVersion();

const checkDatabase = async (): Promise<DependencyState> => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return 'up';
  } catch (error) {
    logger.error('health.databaseDown', {
      detail: error instanceof Error ? error.message : String(error),
    });

    return 'down';
  }
};

/**
 * Are there migrations in `prisma/migrations` that this database has not
 * applied? A deploy that starts serving against an un-migrated database fails
 * in ways that look like application bugs, so the readiness gate refuses first.
 */
const checkMigrations = async (): Promise<{ state: DependencyState; pending: number }> => {
  try {
    const migrationsDir = path.join(__dirname, '..', '..', '..', 'prisma', 'migrations');
    const onDisk = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL
    `;

    const appliedNames = new Set(applied.map((row) => row.migration_name));
    const pending = onDisk.filter((name) => !appliedNames.has(name));

    return { state: pending.length === 0 ? 'up' : 'down', pending: pending.length };
  } catch (error) {
    logger.error('health.migrationCheckFailed', {
      detail: error instanceof Error ? error.message : String(error),
    });

    return { state: 'down', pending: -1 };
  }
};

/**
 * `GET /api/v1/health` (observability.md §5) — the uptime-monitor endpoint.
 *
 * Unauthenticated, plaintext (it is on the encryption bypass list — a monitor
 * cannot decrypt), and deliberately shallow: process up, uptime, build version,
 * `SELECT 1`. Nothing here reveals more than up/down per dependency.
 */
healthRouter.get('/', (_req, res, next) => {
  void (async () => {
    try {
      const database = await checkDatabase();
      const healthy = database === 'up';

      handleApiResponse(res, {
        statusCode: healthy ? 200 : 503,
        responseType: RES_STATUS.GET,
        messageKey: healthy ? MSG_KEYS.HEALTHY : MSG_KEYS.NOT_READY,
        data: {
          status: healthy ? 'ok' : 'degraded',
          env: environment.appEnv,
          version,
          uptimeSeconds: Math.round(process.uptime()),
          timestamp: new Date().toISOString(),
          db: database,
        },
      });
    } catch (error) {
      next(error);
    }
  })();
});

/**
 * `GET /api/v1/health/ready` — the deploy gate.
 *
 * Health, plus the two things that make a process able to actually serve:
 * no pending migrations, and a writable storage path. Returns 503 when either
 * fails, so a rollout stops instead of draining traffic into a broken instance.
 */
healthRouter.get('/ready', (_req, res, next) => {
  void (async () => {
    try {
      const [database, migrations, storageWritable] = await Promise.all([
        checkDatabase(),
        checkMigrations(),
        getStorage().healthCheck(),
      ]);

      const ready = database === 'up' && migrations.state === 'up' && storageWritable;

      handleApiResponse(res, {
        statusCode: ready ? 200 : 503,
        responseType: RES_STATUS.GET,
        messageKey: ready ? MSG_KEYS.HEALTHY : MSG_KEYS.NOT_READY,
        data: {
          status: ready ? 'ready' : 'not-ready',
          env: environment.appEnv,
          version,
          uptimeSeconds: Math.round(process.uptime()),
          timestamp: new Date().toISOString(),
          db: database,
          migrations: migrations.state,
          pendingMigrations: migrations.pending,
          storage: storageWritable ? 'up' : 'down',
          jobs: environment.enableJobs ? 'enabled' : 'disabled',
        },
      });
    } catch (error) {
      next(error);
    }
  })();
});
