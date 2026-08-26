/**
 * Re-apply the notification templates from the seed.
 *
 * The seed upserts and DOES update `subject`/`body` — templates are content, so
 * a correction there is meant to reach the database. This script exists because
 * running the whole seed to fix one stale template is a bigger blast radius than
 * the problem deserves.
 */
import { PrismaClient } from '@prisma/client';
import { seedNotificationTemplates } from '../prisma/seed/notificationTemplates';

const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const count = await seedNotificationTemplates(prisma);
  console.log(`notification templates re-applied: ${count}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
