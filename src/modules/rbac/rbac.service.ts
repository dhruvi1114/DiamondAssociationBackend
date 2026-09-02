import bcrypt from 'bcryptjs';
import { UserStatus } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { BCRYPT_COST } from '@constant/auth.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { SUPER_ADMIN_ROLE } from '@middleware/authorize';
import { revokeAllAuthTokens } from '@modules/auth/auth.repository';
import { clearAdminAccessCache, invalidateAdminAccess } from '@modules/rbac/rbac.cache';
import * as repo from '@modules/rbac/rbac.repository';
import type {
  AdminUserDto,
  CreateAdminUserInput,
  ListAdminUsersQuery,
  RoleDto,
  UpdateAdminUserInput,
} from '@modules/rbac/rbac.types';
import { AppError } from '@utils/appError';

/**
 * Staff-account and role administration (AJ-9).
 *
 * Two guard rails are enforced here and nowhere else, because both are questions
 * about the *whole* table rather than about the row being edited:
 *
 *  - **The last super admin cannot be stood down.** Not by deactivation, not by
 *    revoking the SUPER_ADMIN role. An RBAC screen that can lock every
 *    administrator out of RBAC is a screen that eventually will.
 *  - **You cannot deactivate yourself.** Different failure, same shape: the
 *    person who would have to undo it is the person who just lost access.
 *
 * Both are checked against the state that *would* result, not the state that is
 * — `countActiveSuperAdmins(excludeAdminId)` answers "how many are left if I do
 * this", which is the only version of the question worth asking.
 */

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const adminNotFound = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'rbac.adminNotFound' });

const lastSuperAdmin = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey: 'rbac.lastSuperAdmin' });

const cannotActOnSelf = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey: 'rbac.cannotRemoveOwnAccess' });

const toDto = (row: repo.AdminUserListItem): AdminUserDto => ({
  id: row.id.toString(),
  email: row.email,
  full_name: row.full_name,
  phone: row.phone,
  status: row.status,
  is_super_admin: row.is_super_admin,
  last_login_at: row.last_login_at?.toISOString() ?? null,
  created_at: row.createdAt.toISOString(),
  roles: row.roles,
});

export const listAdminUsers = async (
  query: ListAdminUsersQuery,
): Promise<{ rows: AdminUserDto[]; total: number }> => {
  const result = await repo.listAdminUsers(prisma, query);

  return { rows: result.rows.map(toDto), total: result.total };
};

export const getAdminUser = async (id: bigint): Promise<AdminUserDto> => {
  const row = await repo.findAdminUserById(prisma, id);

  if (!row) {
    throw adminNotFound();
  }

  return toDto(row);
};

export const listRoles = async (): Promise<RoleDto[]> => {
  const roles = await repo.listRoles(prisma);

  return roles.map((role) => ({
    id: role.id.toString(),
    code: role.code,
    name: role.name,
    description: role.description,
    is_system: role.is_system,
    permissions: role.permissions.map((grant) => grant.permission.code).sort(),
  }));
};

/**
 * Create a staff account.
 *
 * `is_super_admin` is deliberately NOT settable through this endpoint. The flag
 * bypasses every permission check, and a create form that can mint one turns
 * "compromise an account with rbac.manage" into "own the platform". Granting the
 * SUPER_ADMIN *role* is the supported path and is visible in an access review;
 * setting the flag stays a seed/DBA action (rbac.md §8).
 */
/** Every permission the platform defines — the matrix's rows. */
export const listPermissions = async (): Promise<
  { code: string; description: string | null }[]
> => {
  const rows = await repo.listPermissions(prisma);

  return rows.map((row) => ({ code: row.code, description: row.description }));
};

/**
 * Replace a role's permissions.
 *
 * Three guards, and each one exists because the screen that calls this is the
 * screen that can lock everybody out of itself:
 *
 *  - **SUPER_ADMIN cannot be edited.** The role carries a blanket bypass
 *    (rbac.md §2/§3), so its grant list decides nothing — but emptying it would
 *    read on the matrix as though it did, and the next person would trust the
 *    screen over the code.
 *  - **You cannot edit a role you yourself hold**, unless you are a super
 *    admin. This is a replace, not a diff, so one careless save strips a role to
 *    whatever was ticked — and doing that to your OWN role removes your access
 *    to the screen that would put it back. A super admin is exempt because the
 *    `is_super_admin` flag bypasses every check, so they cannot lock themselves
 *    out this way.
 *
 *    An earlier version guarded only against removing `rbac.manage` from your
 *    own role. That guard could essentially never fire: `rbac.manage` is granted
 *    to SUPER_ADMIN alone (rbac.md §3), and the SUPER_ADMIN role is refused
 *    above — so it protected nothing while reading as though it did.
 *  - **A permission code that does not exist is refused**, rather than silently
 *    dropped. A matrix that accepts a save and then shows fewer ticks than were
 *    pressed is a screen nobody trusts twice.
 */
export const setRolePermissions = async (
  roleCode: string,
  codes: string[],
  actor: Actor & { roles: string[]; isSuperAdmin: boolean },
): Promise<{ code: string; permissions: string[] }> => {
  const role = await repo.findRoleByCode(prisma, roleCode);

  if (!role) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'rbac.roleNotFound' });
  }

  if (role.code === SUPER_ADMIN_ROLE) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'rbac.superAdminRoleFixed',
    });
  }

  const wanted = [...new Set(codes)];
  const found = await repo.findPermissionsByCodes(prisma, wanted);

  if (found.length !== wanted.length) {
    const known = new Set(found.map((row) => row.code));

    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'rbac.unknownPermission',
      replacements: { permission: wanted.find((code) => !known.has(code)) ?? '' },
    });
  }

  if (actor.roles.includes(role.code) && !actor.isSuperAdmin) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'rbac.cannotEditOwnRole',
    });
  }

  const before = await repo.currentRolePermissions(prisma, role.id);

  await prisma.$transaction(async (tx) => {
    await repo.setRolePermissions(
      tx,
      role.id,
      found.map((row) => row.id),
    );

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ROLE_PERMISSIONS_UPDATED,
      entityName: 'Roles',
      entityId: role.id,
      // Only the codes, and only the two sets — enough to answer "who widened
      // this role and when" without copying the whole permission table.
      before: { permissions: before },
      after: { permissions: wanted.sort() },
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  /*
    Every holder of this role has a cached permission set that is now wrong, and
    this module caches by ADMIN, not by role — so there is no list of exactly who
    to invalidate without a second query. The whole cache is cleared instead.

    Cheap and correct: a role's grants change rarely, the cache refills on the
    next request per admin, and the alternative — leaving stale sets in place
    until the TTL — means a permission you just revoked keeps working for
    minutes.
  */
  clearAdminAccessCache();

  return { code: role.code, permissions: wanted.sort() };
};

export const createAdminUser = async (
  input: CreateAdminUserInput,
  actor: Actor,
): Promise<AdminUserDto> => {
  const existing = await repo.findAdminUserByEmail(prisma, input.email);

  if (existing) {
    // Enumeration is not a concern here: the caller is already an authenticated
    // super admin, and telling them the address is taken is the difference
    // between a fixable form error and a mystery.
    throw new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey: 'rbac.adminEmailExists' });
  }

  const roleCodes = input.role_codes ?? [];
  const roles = roleCodes.length > 0 ? await repo.findRolesByCodes(prisma, roleCodes) : [];

  if (roles.length !== roleCodes.length) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'rbac.roleNotFound' });
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  const created = await prisma.$transaction(async (tx) => {
    const admin = await repo.createAdminUser(tx, {
      email: input.email,
      password_hash: passwordHash,
      full_name: input.full_name,
      phone: input.phone ?? null,
      is_super_admin: false,
      created_by_admin_id: actor.id,
    });

    for (const role of roles) {
      await repo.assignRole(tx, {
        adminUserId: admin.id,
        roleId: role.id,
        assignedByAdminId: actor.id,
      });
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ADMIN_USER_CREATED,
      entityName: 'AdminUsers',
      entityId: admin.id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      after: {
        email: admin.email,
        full_name: admin.full_name,
        status: admin.status,
        roles: roles.map((role) => role.code),
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return admin;
  });

  return getAdminUser(created.id);
};

/**
 * Edit a staff account's profile or status.
 *
 * Deactivating revokes every live session in the same transaction — an INACTIVE
 * account whose 30-minute access token still works is a deactivation that did
 * not take effect, and `authenticateAdmin` would only catch it on the next
 * request anyway.
 */
export const updateAdminUser = async (
  id: bigint,
  input: UpdateAdminUserInput,
  actor: Actor,
): Promise<AdminUserDto> => {
  const target = await repo.loadAdminAccess(prisma, id);

  if (!target) {
    throw adminNotFound();
  }

  const deactivating =
    input.status === UserStatus.INACTIVE && target.status !== UserStatus.INACTIVE;

  if (deactivating) {
    if (id === actor.id) {
      throw cannotActOnSelf();
    }

    const holdsSuperAdmin =
      target.is_super_admin || target.roles.some((role) => role.code === SUPER_ADMIN_ROLE);

    if (holdsSuperAdmin && (await repo.countActiveSuperAdmins(prisma, id)) === 0) {
      throw lastSuperAdmin();
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.adminUser.update({
      where: { id },
      data: {
        full_name: input.full_name,
        phone: input.phone === undefined ? undefined : input.phone,
        status: input.status,
      },
    });

    if (deactivating) {
      await revokeAllAuthTokens(tx, { adminUserId: id });
    }

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ADMIN_USER_UPDATED,
      entityName: 'AdminUsers',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { full_name: target.full_name, status: target.status },
      after: { ...input, sessions_revoked: deactivating },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  invalidateAdminAccess(id);

  return getAdminUser(id);
};

export const assignRole = async (
  id: bigint,
  roleCode: string,
  actor: Actor,
): Promise<AdminUserDto> => {
  const target = await repo.loadAdminAccess(prisma, id);

  if (!target) {
    throw adminNotFound();
  }

  const [role] = await repo.findRolesByCodes(prisma, [roleCode]);

  if (!role) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'rbac.roleNotFound' });
  }

  await prisma.$transaction(async (tx) => {
    await repo.assignRole(tx, { adminUserId: id, roleId: role.id, assignedByAdminId: actor.id });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ADMIN_USER_ROLE_ASSIGNED,
      entityName: 'AdminUserRoles',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      after: { admin_user_id: id.toString(), role: role.code },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  // The grant is visible on the target's next request rather than up to 60
  // seconds later. The TTL remains the guarantee for changes made elsewhere.
  invalidateAdminAccess(id);

  return getAdminUser(id);
};

export const revokeRole = async (
  id: bigint,
  roleCode: string,
  actor: Actor,
): Promise<AdminUserDto> => {
  const target = await repo.loadAdminAccess(prisma, id);

  if (!target) {
    throw adminNotFound();
  }

  const [role] = await repo.findRolesByCodes(prisma, [roleCode]);

  if (!role) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'rbac.roleNotFound' });
  }

  if (role.code === SUPER_ADMIN_ROLE) {
    // Order matters. Both guards can be true at once when a lone super admin
    // tries to strip their own role, and "assign the role to someone else
    // first" is the message that names the fix — "you cannot remove your own
    // access" leaves them guessing.
    //
    // `countActiveSuperAdmins` excludes the target and counts the
    // `is_super_admin` flag as well as the role, so it answers the real
    // question: would anyone be left who can administer RBAC?
    if (!target.is_super_admin && (await repo.countActiveSuperAdmins(prisma, id)) === 0) {
      throw lastSuperAdmin();
    }

    if (id === actor.id) {
      throw cannotActOnSelf();
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const deleted = await repo.revokeRole(tx, id, role.id);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.ADMIN_USER_ROLE_REVOKED,
      entityName: 'AdminUserRoles',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { admin_user_id: id.toString(), role: role.code },
      after: { removed: deleted.count },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return deleted;
  });

  if (result.count > 0) {
    invalidateAdminAccess(id);
  }

  return getAdminUser(id);
};
