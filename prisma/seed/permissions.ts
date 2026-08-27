import type { PrismaClient } from '@prisma/client';

/**
 * The permission catalogue from `docs/rbac.md` §3.
 *
 * `Permissions.code` is `<module>.<action>` and is what `authorize()` receives,
 * so this list and the guards in the route files must agree exactly. Rows are
 * only ever created by this seed — an unknown code at runtime is a bug, not a
 * missing row.
 *
 * OQ-1: the matrix is proposed and awaiting client sign-off. Changing a grant
 * later is a `roles.ts` edit; changing a *code* is a breaking change.
 */
export const PERMISSION_CATALOGUE: { code: string; description: string }[] = [
  { code: 'dashboard.view', description: 'See the admin dashboard and work queue.' },

  { code: 'member.view', description: 'View member records and their profile detail.' },
  { code: 'member.manage', description: 'Create and edit member records.' },
  { code: 'member.status', description: 'Suspend, reactivate or terminate a membership.' },
  { code: 'member.approve_change', description: 'Decide member profile change requests.' },
  { code: 'member.export', description: 'Export the member list.' },

  { code: 'application.view', description: 'View membership applications and their documents.' },
  { code: 'application.approve', description: 'Approve a membership application at your stage.' },
  {
    code: 'application.reject',
    description:
      'Reject a membership application — sending it back for correction while attempts remain, and closing it at the cap.',
  },
  {
    code: 'application.reassign',
    description: 'Reassign an application to another stage or approver.',
  },

  { code: 'document.verify', description: 'Mark an uploaded KYC document verified or rejected.' },

  { code: 'category.view', description: 'View membership categories and tiers.' },
  { code: 'category.manage', description: 'Create and edit membership categories and tiers.' },

  { code: 'fee.view', description: 'View fee structures.' },
  { code: 'fee.manage', description: 'Create and edit fee structures.' },

  { code: 'invoice.view', description: 'View invoices.' },
  { code: 'invoice.manage', description: 'Issue, edit and cancel invoices.' },

  { code: 'payment.view', description: 'View payments and receipts.' },
  { code: 'payment.record', description: 'Record an offline payment against an invoice.' },
  { code: 'refund.manage', description: 'Request, approve and process refunds.' },

  { code: 'renewal.view', description: 'View renewal queues and expiring memberships.' },
  { code: 'renewal.manage', description: 'Run renewals and manage reminders.' },

  { code: 'event.view', description: 'View events and registrations.' },
  { code: 'event.manage', description: 'Create, edit, publish and cancel events.' },
  { code: 'event.attendance', description: 'Record attendance and check attendees in.' },

  { code: 'news.view', description: 'View news articles and news categories.' },
  {
    code: 'news.manage',
    description:
      'Write, edit, publish, unpublish and archive news articles, and curate news categories.',
  },

  { code: 'notice.view', description: 'View notices and circulars.' },
  { code: 'notice.manage', description: 'Create and edit notices and circulars.' },
  { code: 'notice.publish', description: 'Publish a notice to its audience.' },

  { code: 'template.manage', description: 'Edit notification templates.' },
  { code: 'notification.view', description: 'View the notification outbox and delivery status.' },

  { code: 'report.view', description: 'View reports.' },
  { code: 'report.export', description: 'Export reports.' },

  { code: 'org.manage', description: 'Manage designations, committees and chapters.' },
  { code: 'audit.view', description: 'View the audit log.' },
  { code: 'rbac.manage', description: 'Manage roles and their permissions.' },
  { code: 'settings.manage', description: 'Change system settings.' },

  { code: 'workflow.view', description: 'View the approval workflow configuration.' },
  { code: 'workflow.manage', description: 'Edit the approval workflow configuration.' },
];

export const seedPermissions = async (prisma: PrismaClient): Promise<number> => {
  for (const permission of PERMISSION_CATALOGUE) {
    const [module, action] = permission.code.split('.');

    if (!module || !action) {
      throw new Error(`Permission code "${permission.code}" is not "<module>.<action>"`);
    }

    // Upsert by the natural key so re-running the seed is a no-op, and so a
    // reworded description propagates without creating a duplicate row.
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { module, action, description: permission.description },
      create: { code: permission.code, module, action, description: permission.description },
    });
  }

  return PERMISSION_CATALOGUE.length;
};
