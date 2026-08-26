import bcrypt from 'bcryptjs';
import { UserStatus, type PrismaClient } from '@prisma/client';

/** rbac.md §1 — bcrypt cost 12 for both audiences. */
const BCRYPT_COST = 12;
const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** The three non-super roles the Sentinel `rbac` suite needs to exercise. */
const TEST_ROLES = [
  { code: 'ADMIN', envPrefix: 'SEED_TEST_ADMIN' },
  { code: 'APPROVER', envPrefix: 'SEED_TEST_APPROVER' },
  { code: 'ACCOUNTS', envPrefix: 'SEED_TEST_ACCOUNTS' },
] as const;

/**
 * Non-production staff accounts, one per non-super role.
 *
 * Why this exists: `rbac.md` §3 defines a permission matrix, and the Sentinel
 * `rbac` suite is meant to prove — per role — that an allowed call returns 2xx
 * and a forbidden one returns 403. Without an account for ADMIN, APPROVER and
 * ACCOUNTS that suite can only cover SUPER_ADMIN, and a matrix nobody exercises
 * is decoration. Three of four roles were reported "not covered" on the first
 * M1 run, which is exactly the false-green this harness is supposed to prevent.
 *
 * Two safety rails, because seeded staff logins are a genuine liability:
 *
 *  1. **Refuses to run outside local/dev.** `APP_ENV=staging|production` is a
 *     hard stop, not a warning — a test approver in production could approve a
 *     real membership.
 *  2. **No default passwords.** Each account needs its own env pair, exactly
 *     like `superAdmin.ts`. A missing pair skips that role and says so; it never
 *     invents a credential.
 *
 * Idempotent: an existing account keeps its password, so re-seeding never
 * silently rotates a credential a developer is using.
 */
export const seedTestAdmins = async (prisma: PrismaClient): Promise<string> => {
  const appEnv = process.env.APP_ENV ?? 'local';

  if (appEnv !== 'local' && appEnv !== 'dev') {
    return `skipped — APP_ENV=${appEnv} (test staff accounts exist only in local/dev)`;
  }

  if (process.env.SEED_TEST_ADMINS !== 'true') {
    return 'skipped — set SEED_TEST_ADMINS=true to create per-role test staff';
  }

  const created: string[] = [];
  const skipped: string[] = [];

  for (const role of TEST_ROLES) {
    const email = process.env[`${role.envPrefix}_EMAIL`]?.trim();
    const password = process.env[`${role.envPrefix}_PASSWORD`];

    if (!email || !password) {
      skipped.push(`${role.code} (no ${role.envPrefix}_EMAIL/_PASSWORD)`);
      continue;
    }

    if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
      throw new Error(
        `${role.envPrefix}_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters (rbac.md §1).`,
      );
    }

    const roleRow = await prisma.role.findUnique({
      where: { code: role.code },
      select: { id: true },
    });

    if (!roleRow) {
      throw new Error(`Role ${role.code} not found — run the roles seed first.`);
    }

    const existing = await prisma.adminUser.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });

    const adminId =
      existing?.id ??
      (
        await prisma.adminUser.create({
          data: {
            email,
            full_name: `${role.code} (test)`,
            password_hash: await bcrypt.hash(password, BCRYPT_COST),
            status: UserStatus.ACTIVE,
            email_verified_at: new Date(),
            is_super_admin: false,
          },
          select: { id: true },
        })
      ).id;

    await prisma.adminUserRole.upsert({
      where: { admin_user_id_role_id: { admin_user_id: adminId, role_id: roleRow.id } },
      create: { admin_user_id: adminId, role_id: roleRow.id },
      update: {},
    });

    created.push(role.code);
  }

  const parts = [
    created.length ? `${created.join(', ')} ready` : 'none created',
    skipped.length ? `skipped: ${skipped.join(', ')}` : '',
  ].filter(Boolean);

  return parts.join(' — ');
};
