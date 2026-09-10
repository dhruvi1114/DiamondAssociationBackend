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
  /**
   * Whether the stage takes part in the flow. Absent means active — a stage is
   * only ever switched off deliberately, and the column defaults the same way.
   */
  isActive?: boolean;
}

/*
 * One active stage: Final approval (approval-stage-toggle spec, D-2).
 *
 * The other two are switched off, not removed. Committee review is a rubber
 * stamp — no committee meets — and Document verification splits work across a
 * maker and a checker who are currently the same super admin, which records a
 * control in the audit log that does not exist in the building.
 *
 * Off does NOT mean optional. The document gate runs on every approve in
 * `application.service.ts`, not at a named stage, so an application with an
 * unverified required document is still refused with Document verification
 * switched off (D-6). That is what makes switching it off safe.
 *
 * To bring maker-checker back: set `isActive: true` here and re-run the seed.
 * Sequences never moved, so the stage returns to its own position, all of its
 * decision history is still attached, and no migration is involved (§8).
 */
const MEMBERSHIP_STAGES: StageSeed[] = [
  {
    sequence: 1,
    name: 'Document verification',
    roleCode: 'ADMIN',
    slaHours: 48,
    isActive: false,
  },
  {
    sequence: 2,
    name: 'Committee review',
    roleCode: 'APPROVER',
    slaHours: 120,
    isActive: false,
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
        is_active: stage.isActive ?? true,
      },
      // `is_active` is written on BOTH branches so a re-run re-asserts the
      // configuration above. Leaving it off `update` would let a stage switched
      // on by hand in the database survive every later seed, and the file would
      // stop describing the workflow that is actually running.
      update: {
        name: stage.name,
        approver_role_id: role.id,
        is_final: stage.isFinal ?? false,
        sla_hours: stage.slaHours ?? null,
        is_active: stage.isActive ?? true,
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
