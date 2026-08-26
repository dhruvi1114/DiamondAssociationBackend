import { Prisma, PrismaClient } from '@prisma/client';
import { environment } from '@config/config';
import { logger } from '@logger/logger';

/**
 * Anything that can run a query: the root client or an interactive transaction
 * client. Every repository and every helper that may participate in a caller's
 * transaction takes this type, never `PrismaClient` — that is what makes
 * "notification queued in the same transaction as the approval" (ADR-010)
 * expressible instead of aspirational.
 */
export type PrismaTransactionClient = Prisma.TransactionClient;

export type Db = PrismaClient | PrismaTransactionClient;

/**
 * Every level is emitted as an event and the handlers decide what is written,
 * so Prisma never writes to stdout itself and everything passes through the
 * redacting logger. The config has to be an inline literal for Prisma to type
 * `$on` — a widened `PrismaClient` makes every event name `never`.
 */
const createClient = () => {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });

  client.$on('warn', (event) => {
    logger.warn('prisma.warn', { detail: event.message });
  });

  client.$on('error', (event) => {
    logger.error('prisma.error', { detail: event.message });
  });

  client.$on('query', (event) => {
    // Query text can embed parameter values, so this is local-only.
    if (environment.isLocal) {
      logger.debug('prisma.query', { durationMs: event.duration, query: event.query });
    }
  });

  return client;
};

let prismaInstance: ReturnType<typeof createClient> | null = null;

export const getPrismaClient = (): PrismaClient => {
  if (!prismaInstance) {
    prismaInstance = createClient();
  }

  return prismaInstance;
};

export const prisma = getPrismaClient();

/** Closes the pool on shutdown so Postgres does not accumulate idle backends. */
export const disconnectPrisma = async (): Promise<void> => {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
};
