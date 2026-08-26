import http from 'http';
import { createApp } from '@app/app';
import { environment } from '@config/config';
import { GlobalErrorHandler } from '@middleware';
import { disconnectPrisma, prisma } from '@db/prisma';
import { getStorage } from '@helpers/storage';
import { startJobs, stopJobs } from '@jobs/index';
import { logger } from '@logger/logger';
import { emailChannel } from '@notifications/channels';

// Prisma returns BIGSERIAL keys as BigInt, which JSON.stringify refuses to
// serialise. Ids go over the wire as strings; the frontends never do arithmetic
// on them, and a Number would silently lose precision past 2^53.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function toJSON() {
  return this.toString();
};

const app = createApp();
const server = http.createServer(app);

/**
 * Best-effort crash notification (observability.md §6). Deliberately bypasses
 * the outbox: the process is about to exit, so a queued row would never be
 * drained. Failure here is swallowed — a broken mailer must not stop the exit.
 */
const notifyCrash = async (context: string, error: unknown): Promise<void> => {
  if (!environment.mail.crashMail) {
    return;
  }

  await emailChannel.send({
    notificationId: 0n,
    channel: 'EMAIL',
    templateCode: 'system.crash',
    subject: `[${environment.appEnv}] API crashed: ${context}`,
    body: [
      `Environment: ${environment.appEnv}`,
      `Context: ${context}`,
      `Time: ${new Date().toISOString()}`,
      `Detail: ${error instanceof Error ? error.message : String(error)}`,
    ].join('\n'),
    toAddress: environment.mail.crashMail,
  });
};

const shutdown = async (signal: string): Promise<void> => {
  logger.info('server.shuttingDown', { signal });

  stopJobs();

  server.close(() => {
    void disconnectPrisma().finally(() => process.exit(0));
  });

  // Do not wait forever on in-flight requests during a deploy.
  setTimeout(() => process.exit(0), 10_000).unref();
};

const startServer = async (): Promise<void> => {
  GlobalErrorHandler((context, error) => notifyCrash(context, error));

  try {
    await prisma.$connect();
  } catch (error) {
    logger.error('server.databaseConnectFailed', {
      detail: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  logger.info('server.databaseConnected');

  // Fail loudly at boot rather than on the first upload if the storage root is
  // unusable — a KYC upload that 500s is a much worse first symptom.
  const storageWritable = await getStorage().healthCheck();

  if (!storageWritable) {
    logger.error('server.storageNotWritable', { storagePath: environment.storagePath });
  }

  startJobs();

  server.listen(environment.port, () => {
    logger.info('server.listening', {
      port: environment.port,
      env: environment.appEnv,
      jobs: environment.enableJobs,
      mailTransport: environment.mail.transport,
    });
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

void startServer();
