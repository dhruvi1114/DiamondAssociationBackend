import { UserStatus } from '@prisma/client';
import { z } from 'zod';
import { adminPassword } from '@modules/auth/auth.types';

/**
 * Request schemas and DTOs for staff-account and role administration (AJ-9,
 * screens A-31/A-32). Every one of these endpoints is `rbac.manage` +
 * SUPER_ADMIN, so the schemas can be stricter than the member-facing ones
 * without costing a legitimate user anything.
 */

const email = z
  .string({ required_error: 'validation.invalidEmail' })
  .trim()
  .min(1, 'validation.invalidEmail')
  .max(150, 'validation.invalidEmail')
  .email('validation.invalidEmail')
  .transform((value) => value.toLowerCase());

/**
 * A repeated filter arrives as `?status=A,B`. Split, trim and drop blanks, so a
 * trailing comma or an empty selection is an absent filter rather than a 422 —
 * the same helper shape the member and invoice lists use, so the admin app's
 * filter panel can be a `MultiSelect` here like it is everywhere else.
 */
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(item).nonempty().optional());

const roleCode = z
  .string({ required_error: 'rbac.roleNotFound' })
  .trim()
  .min(1, 'rbac.roleNotFound')
  .max(50, 'rbac.roleNotFound');

export const listAdminUsersSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Clamped rather than rejected: api-conventions.md §6 says the server clamps
  // an over-large limit and never errors on it.
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((value) => Math.min(value, 100)),
  search: z.string().trim().min(1).max(150).optional(),
  /** A list, not one value: "active OR inactive" is a real question to ask. */
  status: csv(z.nativeEnum(UserStatus)),
});

export const createAdminUserSchema = z.object({
  email,
  full_name: z.string({ required_error: 'validation.requiredFields' }).trim().min(2).max(150),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\s-]{6,19}$/, 'validation.invalidPhone')
    .optional(),
  password: adminPassword,
  /**
   * Roles granted at creation. Optional and may be empty — a staff account with
   * no role is a legitimate intermediate state (A-01 handles it), not an error.
   */
  role_codes: z.array(roleCode).max(10).optional(),
});

export const updateAdminUserSchema = z
  .object({
    full_name: z.string().trim().min(2).max(150).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9\s-]{6,19}$/, 'validation.invalidPhone')
      .nullable()
      .optional(),
    /** Only ACTIVE and INACTIVE are settable here; BLOCKED is M3's member flow. */
    status: z.enum([UserStatus.ACTIVE, UserStatus.INACTIVE]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'validation.requiredFields',
  });

export const assignRoleSchema = z.object({ role_code: roleCode });

export const adminUserIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
});

export const adminUserRoleParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, 'validation.invalidId'),
  roleCode,
});

export type ListAdminUsersQuery = z.infer<typeof listAdminUsersSchema>;
export type CreateAdminUserInput = z.infer<typeof createAdminUserSchema>;
export type UpdateAdminUserInput = z.infer<typeof updateAdminUserSchema>;
export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

export interface AdminUserDto {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: UserStatus;
  is_super_admin: boolean;
  last_login_at: string | null;
  created_at: string;
  roles: { code: string; name: string }[];
}

export interface RoleDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
}

export const roleCodeParamSchema = z.object({ roleCode });

/**
 * The permissions a role should hold — the whole set, not a diff.
 *
 * A replace rather than add/remove because the screen is a matrix: the admin
 * ticks and unticks boxes and presses Save, and sending "the state I want"
 * cannot drift from what they are looking at the way a sequence of deltas can.
 */
export const setRolePermissionsSchema = z.object({
  permission_codes: z.array(z.string().trim().min(1).max(80)).max(200),
});

export type SetRolePermissionsInput = z.infer<typeof setRolePermissionsSchema>;

export interface PermissionDto {
  code: string;
  description: string | null;
}
