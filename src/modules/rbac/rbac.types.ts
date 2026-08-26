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
  status: z.nativeEnum(UserStatus).optional(),
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
