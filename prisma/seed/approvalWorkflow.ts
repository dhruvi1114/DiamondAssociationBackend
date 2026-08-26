import { ApprovalSubjectType, type PrismaClient } from '@prisma/client';

/**
 * The approval flow, as data (user decision, 2026-08-13).
 *
 * Each stage names the ROLE that owns its queue, so moving approval authority —
 * or adding a stage — is a re-seed rather than a deployment. The default below
 * is `approval-workflow.md` §2b; the federation can change it without code.
 *
 * Idempotent: re-running updates the stage list in place rather than duplicating
 * it, and never touches an application already in flight.
 */

interface StageSeed {
  sequence: number;
  name: string;
  roleCode: string;
  isFinal?: boolean;
  slaHours?: number;
}

const MEMBERSHIP_STAGES: StageSeed[] = [
  {
    sequence: 1,
    name: 'Document verification',
    roleCode: 'ADMIN',
    slaHours: 48,
  },
  {
    sequence: 2,
    name: 'Committee review',
    roleCode: 'APPROVER',
    slaHours: 120,
  },
  {
    sequence: 3,
    name: 'Final approval',
    roleCode: 'SUPER_ADMIN',
    isFinal: true,
    slaHours: 72,
  },
];

const PROFILE_CHANGE_STAGES: StageSeed[] = [
  {
    sequence: 1,
    name: 'Profile change review',
    roleCode: 'ADMIN',
    isFinal: true,
  },
];

const seedWorkflow = async (
  prisma: PrismaClient,
  code: string,
  name: string,
  subjectType: ApprovalSubjectType,
  stages: StageSeed[],
): Promise<void> => {
  const workflow = await prisma.approvalWorkflow.upsert({
    where: { code },
    create: { code, name, subject_type: subjectType },
    update: { name },
  });

  for (const stage of stages) {
    const role = await prisma.role.findUnique({ where: { code: stage.roleCode } });
    if (!role) throw new Error(`Role ${stage.roleCode} not found — run the roles seed first.`);

    await prisma.approvalStage.upsert({
      where: { workflow_id_sequence: { workflow_id: workflow.id, sequence: stage.sequence } },
      create: {
        workflow_id: workflow.id,
        sequence: stage.sequence,
        name: stage.name,
        approver_role_id: role.id,
        is_final: stage.isFinal ?? false,
        sla_hours: stage.slaHours ?? null,
      },
      update: {
        name: stage.name,
        approver_role_id: role.id,
        is_final: stage.isFinal ?? false,
        sla_hours: stage.slaHours ?? null,
      },
    });
  }
};

export const seedApprovalWorkflows = async (prisma: PrismaClient): Promise<string> => {
  await seedWorkflow(
    prisma,
    'MEMBERSHIP_APPROVAL',
    'Membership approval',
    ApprovalSubjectType.MEMBERSHIP_APPLICATION,
    MEMBERSHIP_STAGES,
  );

  await seedWorkflow(
    prisma,
    'PROFILE_CHANGE_APPROVAL',
    'Profile change approval',
    ApprovalSubjectType.PROFILE_CHANGE_REQUEST,
    PROFILE_CHANGE_STAGES,
  );

  return `2 workflows, ${MEMBERSHIP_STAGES.length + PROFILE_CHANGE_STAGES.length} stages`;
};
