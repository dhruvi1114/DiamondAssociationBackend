/* eslint-disable no-console */
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadEnvironmentFiles } from '../src/config/loadEnv';
import { seedPermissions } from './seed/permissions';
import { seedRoles } from './seed/roles';
import { seedSystemSettings } from './seed/systemSettings';
import { seedNotificationTemplates } from './seed/notificationTemplates';
import { seedSuperAdmin } from './seed/superAdmin';
import { seedApprovalWorkflows } from './seed/approvalWorkflow';
import { seedTestAdmins } from './seed/testAdmins';
import { seedCompanyTypes } from './seed/company-types';
import { seedLocations } from './seed/locations';

/**
 * Idempotent database seed (migration-strategy.md §Seeds).
 *
 * Every step upserts by natural key, so running it twice is a no-op and running
 * it against an existing environment is safe. Ordering matters: permissions
 * before roles (roles resolve permissions by code), roles before the super
 * admin (which is assigned SUPER_ADMIN).
 *
 *   npm run prisma:seed
 */

const appEnv = loadEnvironmentFiles(path.join(__dirname, '..'));

const prisma = new PrismaClient({ log: ['error'] });

const main = async (): Promise<void> => {
  console.log(`Seeding ${appEnv}…`);

  const permissions = await seedPermissions(prisma);
  console.log(`  permissions            ${permissions} upserted`);

  const roles = await seedRoles(prisma);
  console.log(`  roles + grants         ${roles} upserted`);

  const settings = await seedSystemSettings(prisma);
  console.log(`  system settings        ${settings} upserted`);

  const templates = await seedNotificationTemplates(prisma);
  console.log(`  notification templates ${templates} upserted`);

  const superAdmin = await seedSuperAdmin(prisma);
  console.log(`  super admin            ${superAdmin}`);

  const workflows = await seedApprovalWorkflows(prisma);
  console.log(`  approval workflows     ${workflows}`);

  const testAdmins = await seedTestAdmins(prisma);
  console.log(`  test staff (local/dev) ${testAdmins}`);

  const companyTypes = await seedCompanyTypes(prisma);
  console.log(`  company types          ${companyTypes} upserted`);

  const locations = await seedLocations(prisma);
  console.log(
    `  locations              ${locations.countries} country, ${locations.states} states, ${locations.cities} cities`,
  );

  console.log('Seed complete.');
};

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
