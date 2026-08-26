import bcrypt from 'bcryptjs';
import { UserStatus, type PrismaClient } from '@prisma/client';

/** rbac.md §1 — bcrypt cost 12 for both audiences. */
const BCRYPT_COST = 12;
const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Creates the first super admin from `SEED_SUPERADMIN_EMAIL` /
 * `SEED_SUPERADMIN_PASSWORD` (rbac.md §8).
 *
 * Fails loudly when either is unset. There is deliberately no default: a
 * hardcoded `admin@example.com / admin123` that survives to production is the
 * single most common way a platform like this is compromised, and a seed that
 * refuses to run is a much cheaper problem than one that quietly succeeds.
 *
 * Idempotent: re-running does not reset the password of an existing account,
 * so rotating the credential in production is a deliberate act, not a
 * side effect of a deploy.
 */
export const seedSuperAdmin = async (prisma: PrismaClient): Promise<string> => {
  const email = process.env.SEED_SUPERADMIN_EMAIL?.trim();
  const password = process.env.SEED_SUPERADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must be set — the seed refuses to ' +
        'invent credentials (rbac.md §8). Set them in .env.<APP_ENV> and re-run.',
    );
  }

  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `SEED_SUPERADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters (rbac.md §1).`,
    );
  }

  const existing = await prisma.adminUser.findFirst({
    where: { email, deletedAt: null },
    select: { id: true },
  });

  const superAdminRole = await prisma.role.findUnique({
    where: { code: 'SUPER_ADMIN' },
    select: { id: true },
  });

  if (!superAdminRole) {
    throw new Error('SUPER_ADMIN role is missing — run the role seed first.');
  }

  const adminId =
    existing?.id ??
    (
      await prisma.adminUser.create({
        data: {
          email,
          full_name: 'Super Admin',
          password_hash: await bcrypt.hash(password, BCRYPT_COST),
          status: UserStatus.ACTIVE,
          email_verified_at: new Date(),
          is_super_admin: true,
        },
        select: { id: true },
      })
    ).id;

  await prisma.adminUserRole.upsert({
    where: { admin_user_id_role_id: { admin_user_id: adminId, role_id: superAdminRole.id } },
    update: {},
    create: { admin_user_id: adminId, role_id: superAdminRole.id },
  });

  return existing ? 'existing' : 'created';
};
