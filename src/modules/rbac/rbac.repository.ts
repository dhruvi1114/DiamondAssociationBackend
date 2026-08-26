import { Prisma, UserStatus } from '@prisma/client';
import type { Db } from '@db/prisma';

/**
 * RBAC data access.
 *
 * The permission-set read is the hot path — it runs on every admin request that
 * misses the 60-second cache — so it is one parameterised statement with joins
 * and aggregates rather than four round trips (ADR-005). Identifiers are
 * double-quoted because tables are `PascalCasePlural` and columns `snake_case`
 * (ADR-003).
 */

export interface RoleSummary {
  code: string;
  name: string;
}

/** Everything an authorisation decision needs, as of this instant. */
export interface AdminAccess {
  id: bigint;
  email: string;
  full_name: string;
  status: UserStatus;
  is_super_admin: boolean;
  roles: RoleSummary[];
  permissions: string[];
}

interface AdminAccessRow {
  id: bigint;
  email: string;
  full_name: string;
  status: UserStatus;
  is_super_admin: boolean;
  roles: RoleSummary[] | null;
  permissions: string[] | null;
}

/**
 * Live roles and permission codes for one staff account.
 *
 * Returns `null` for an account that is soft-deleted or absent, which the
 * middleware treats as an invalid session — a deleted admin holding a valid
 * 30-minute token must not keep working until it expires.
 *
 * `LEFT JOIN` throughout on purpose: an admin with no roles is a real state
 * (screen-inventory.md A-01 "no-role account") and must return a row with an
 * empty permission list, not no row at all.
 */
export const loadAdminAccess = async (db: Db, adminUserId: bigint): Promise<AdminAccess | null> => {
  const rows = await db.$queryRaw<AdminAccessRow[]>(Prisma.sql`
    SELECT au."id",
           au."email"::text          AS email,
           au."full_name"            AS full_name,
           au."status"               AS status,
           au."is_super_admin"       AS is_super_admin,
           COALESCE(
             jsonb_agg(DISTINCT jsonb_build_object('code', r."code", 'name', r."name"))
               FILTER (WHERE r."id" IS NOT NULL),
             '[]'::jsonb
           )                          AS roles,
           COALESCE(
             jsonb_agg(DISTINCT p."code") FILTER (WHERE p."id" IS NOT NULL),
             '[]'::jsonb
           )                          AS permissions
    FROM "AdminUsers" au
    LEFT JOIN "AdminUserRoles"  aur ON aur."admin_user_id" = au."id"
    LEFT JOIN "Roles"           r   ON r."id"              = aur."role_id"
    LEFT JOIN "RolePermissions" rp  ON rp."role_id"        = r."id"
    LEFT JOIN "Permissions"     p   ON p."id"              = rp."permission_id"
    WHERE au."id" = ${adminUserId}
      AND au."deletedAt" IS NULL
    GROUP BY au."id"
  `);

  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    status: row.status,
    is_super_admin: row.is_super_admin,
    roles: row.roles ?? [],
    permissions: row.permissions ?? [],
  };
};

// ---------------------------------------------------------------------------
// Staff account management (AJ-9, permission `rbac.manage`)
// ---------------------------------------------------------------------------

export interface AdminUserListItem {
  id: bigint;
  email: string;
  full_name: string;
  phone: string | null;
  status: UserStatus;
  is_super_admin: boolean;
  last_login_at: Date | null;
  createdAt: Date;
  roles: RoleSummary[];
}

export interface AdminUserListQuery {
  page: number;
  limit: number;
  search?: string;
  status?: UserStatus;
}

export interface AdminUserListResult {
  rows: AdminUserListItem[];
  total: number;
}

/**
 * Staff list for A-32.
 *
 * One statement, windowed count, roles aggregated in the same pass — no N+1 and
 * no second query for the total (api-conventions.md §6). `search` hits email and
 * full name and is passed as a bound parameter, never interpolated.
 */
export const listAdminUsers = async (
  db: Db,
  query: AdminUserListQuery,
): Promise<AdminUserListResult> => {
  const offset = (query.page - 1) * query.limit;
  const search = query.search ? `%${query.search}%` : null;

  const rows = await db.$queryRaw<(AdminUserListItem & { total: bigint })[]>(Prisma.sql`
    SELECT au."id",
           au."email"::text    AS email,
           au."full_name"      AS full_name,
           au."phone",
           au."status",
           au."is_super_admin" AS is_super_admin,
           au."last_login_at"  AS last_login_at,
           au."createdAt",
           COALESCE(
             jsonb_agg(DISTINCT jsonb_build_object('code', r."code", 'name', r."name"))
               FILTER (WHERE r."id" IS NOT NULL),
             '[]'::jsonb
           )                    AS roles,
           COUNT(*) OVER ()     AS total
    FROM "AdminUsers" au
    LEFT JOIN "AdminUserRoles" aur ON aur."admin_user_id" = au."id"
    LEFT JOIN "Roles"          r   ON r."id"              = aur."role_id"
    WHERE au."deletedAt" IS NULL
      AND (${search}::text IS NULL OR au."email"::text ILIKE ${search} OR au."full_name" ILIKE ${search})
      AND (${query.status ?? null}::"UserStatus" IS NULL OR au."status" = ${query.status ?? null}::"UserStatus")
    GROUP BY au."id"
    ORDER BY au."createdAt" DESC
    LIMIT ${query.limit} OFFSET ${offset}
  `);

  return {
    rows: rows.map(({ total: _total, ...item }) => item),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
};

/** One staff account in the same shape the list returns, for a detail view. */
export const findAdminUserById = async (db: Db, id: bigint): Promise<AdminUserListItem | null> => {
  const rows = await db.$queryRaw<AdminUserListItem[]>(Prisma.sql`
    SELECT au."id",
           au."email"::text    AS email,
           au."full_name"      AS full_name,
           au."phone",
           au."status",
           au."is_super_admin" AS is_super_admin,
           au."last_login_at"  AS last_login_at,
           au."createdAt",
           COALESCE(
             jsonb_agg(DISTINCT jsonb_build_object('code', r."code", 'name', r."name"))
               FILTER (WHERE r."id" IS NOT NULL),
             '[]'::jsonb
           )                    AS roles
    FROM "AdminUsers" au
    LEFT JOIN "AdminUserRoles" aur ON aur."admin_user_id" = au."id"
    LEFT JOIN "Roles"          r   ON r."id"              = aur."role_id"
    WHERE au."id" = ${id}
      AND au."deletedAt" IS NULL
    GROUP BY au."id"
  `);

  return rows[0] ?? null;
};

export const findRolesByCodes = (
  db: Db,
  codes: string[],
): Promise<{ id: bigint; code: string; name: string }[]> =>
  db.role.findMany({
    where: { code: { in: codes } },
    select: { id: true, code: true, name: true },
  });

export const listRoles = (db: Db) =>
  db.role.findMany({
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      is_system: true,
      permissions: { select: { permission: { select: { code: true } } } },
    },
  });

export const assignRole = (
  db: Db,
  input: { adminUserId: bigint; roleId: bigint; assignedByAdminId: bigint },
): Promise<unknown> =>
  db.adminUserRole.upsert({
    where: {
      admin_user_id_role_id: { admin_user_id: input.adminUserId, role_id: input.roleId },
    },
    // Re-assigning an existing role is a no-op rather than an error: the caller's
    // intent ("this person should hold this role") is already satisfied.
    update: {},
    create: {
      admin_user_id: input.adminUserId,
      role_id: input.roleId,
      assigned_by_admin_id: input.assignedByAdminId,
    },
  });

export const revokeRole = (
  db: Db,
  adminUserId: bigint,
  roleId: bigint,
): Promise<{ count: number }> =>
  db.adminUserRole.deleteMany({ where: { admin_user_id: adminUserId, role_id: roleId } });

/**
 * How many staff accounts can still administer RBAC.
 *
 * Counts live, ACTIVE accounts that either carry `is_super_admin` or hold the
 * SUPER_ADMIN role — both routes to the same power, so a guard that checked only
 * one could still strand the platform. `excludeAdminId` answers the question the
 * guard actually asks: "if I do this, how many are left?"
 */
export const countActiveSuperAdmins = async (db: Db, excludeAdminId?: bigint): Promise<number> => {
  const rows = await db.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT au."id")::bigint AS count
    FROM "AdminUsers" au
    LEFT JOIN "AdminUserRoles" aur ON aur."admin_user_id" = au."id"
    LEFT JOIN "Roles"          r   ON r."id"              = aur."role_id"
    WHERE au."deletedAt" IS NULL
      AND au."status" = ${UserStatus.ACTIVE}::"UserStatus"
      AND (au."is_super_admin" = TRUE OR r."code" = 'SUPER_ADMIN')
      AND (${excludeAdminId ?? null}::bigint IS NULL OR au."id" <> ${excludeAdminId ?? null}::bigint)
  `);

  return Number(rows[0]?.count ?? 0);
};

export const createAdminUser = (
  db: Db,
  input: {
    email: string;
    password_hash: string;
    full_name: string;
    phone?: string | null;
    is_super_admin: boolean;
    created_by_admin_id: bigint;
  },
) =>
  db.adminUser.create({
    data: {
      email: input.email,
      password_hash: input.password_hash,
      full_name: input.full_name,
      phone: input.phone ?? null,
      is_super_admin: input.is_super_admin,
      created_by_admin_id: input.created_by_admin_id,
      // Created by a super admin who already knows who this is, so the address is
      // treated as proven — there is no staff signup flow to verify it with.
      status: UserStatus.ACTIVE,
      email_verified_at: new Date(),
    },
    select: { id: true, email: true, full_name: true, status: true, is_super_admin: true },
  });

export const findAdminUserByEmail = (db: Db, email: string): Promise<{ id: bigint } | null> =>
  db.adminUser.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
