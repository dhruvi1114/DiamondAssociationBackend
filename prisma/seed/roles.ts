import type { PrismaClient } from '@prisma/client';
import { PERMISSION_CATALOGUE } from './permissions';

/**
 * The four system roles and their grants — the matrix in `docs/rbac.md` §3.
 *
 * Deliberate choices recorded there, repeated here because they look like bugs
 * otherwise:
 *  - ADMIN both approves and rejects — at THEIR stage only. Stage 1 of the
 *    seeded workflow is document verification, an ADMIN queue, and the reject
 *    /resubmit spec (D-1, 2026-08-25) left Reject as the only way to send an
 *    application back. Withholding it would give stage 1 a reviewer who can pass
 *    an application but not fail one. Stage-role scoping still stops ADMIN
 *    deciding the committee's stages (rbac.md §4).
 *  - ACCOUNTS owns fees, invoices, payments and refunds and cannot touch member
 *    status.
 *  - Only SUPER_ADMIN edits RBAC, templates, workflow and settings.
 *
 * SUPER_ADMIN is granted every permission explicitly as well as carrying
 * `is_super_admin`, so an access review reads the same for every role rather
 * than having to know about a bypass.
 */
interface RoleSeed {
  code: string;
  name: string;
  description: string;
  permissions: string[] | 'ALL';
}

const ROLES: RoleSeed[] = [
  {
    code: 'SUPER_ADMIN',
    name: 'Super admin',
    description: 'Full access, including RBAC, templates, approval workflow and system settings.',
    permissions: 'ALL',
  },
  {
    code: 'ADMIN',
    name: 'Admin',
    description:
      'Association office staff: members, applications at their own stage, events, notices and reports.',
    permissions: [
      'dashboard.view',
      'member.view',
      'member.manage',
      'member.status',
      'member.approve_change',
      'member.export',
      'application.view',
      // Stage 1 of the seeded workflow (document verification) is an ADMIN queue,
      // so ADMIN must be able to decide it — at THEIR stage. Stage-role scoping
      // still stops them deciding the committee's stages (rbac.md §4). Reject
      // came with the retirement of Return: it is now the single action that
      // sends an application back to the applicant.
      'application.approve',
      'application.reject',
      'application.reassign',
      'document.verify',
      'category.view',
      'category.manage',
      'fee.view',
      'invoice.view',
      'payment.view',
      'renewal.view',
      'renewal.manage',
      'event.view',
      'event.manage',
      'event.attendance',
      'notice.view',
      'notice.manage',
      'notice.publish',
      'notification.view',
      'report.view',
      'report.export',
      'org.manage',
      'audit.view',
      'workflow.view',
    ],
  },
  {
    code: 'APPROVER',
    name: 'Approver',
    description:
      'Committee member who decides membership applications at their stage. No financial access.',
    permissions: [
      'dashboard.view',
      'member.view',
      'member.approve_change',
      'application.view',
      'application.approve',
      'application.reject',
      'document.verify',
      'category.view',
      'event.view',
      'notice.view',
      'workflow.view',
    ],
  },
  {
    code: 'ACCOUNTS',
    name: 'Accounts',
    description:
      'Finance staff: fees, invoices, payments, refunds and renewals. No member status changes.',
    permissions: [
      'dashboard.view',
      'member.view',
      'member.export',
      'category.view',
      'fee.view',
      'fee.manage',
      'invoice.view',
      'invoice.manage',
      'payment.view',
      'payment.record',
      'refund.manage',
      'renewal.view',
      'renewal.manage',
      'event.view',
      'report.view',
      'report.export',
    ],
  },
];

export const seedRoles = async (prisma: PrismaClient): Promise<number> => {
  const allCodes = PERMISSION_CATALOGUE.map((permission) => permission.code);

  for (const roleSeed of ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleSeed.code },
      update: { name: roleSeed.name, description: roleSeed.description, is_system: true },
      create: {
        code: roleSeed.code,
        name: roleSeed.name,
        description: roleSeed.description,
        is_system: true,
      },
      select: { id: true },
    });

    const wanted = roleSeed.permissions === 'ALL' ? allCodes : roleSeed.permissions;
    const unknown = wanted.filter((code) => !allCodes.includes(code));

    if (unknown.length > 0) {
      throw new Error(`Role ${roleSeed.code} grants unknown permission(s): ${unknown.join(', ')}`);
    }

    const permissions = await prisma.permission.findMany({
      where: { code: { in: wanted } },
      select: { id: true },
    });

    // Reconcile rather than append: a permission removed from the matrix must
    // actually be revoked, otherwise the seed can only ever widen access.
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({
        where: { role_id: role.id, permission_id: { notIn: permissions.map((p) => p.id) } },
      }),
      prisma.rolePermission.createMany({
        data: permissions.map((permission) => ({
          role_id: role.id,
          permission_id: permission.id,
        })),
        skipDuplicates: true,
      }),
    ]);
  }

  return ROLES.length;
};
