import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ApprovalStage } from '@prisma/client';

/**
 * Reviewer decisions against a workflow with stages switched off
 * (approval-stage-toggle spec §9, "Service (integration)").
 *
 * The engine tests prove the arithmetic; these prove the transaction obeys it —
 * that a one-step workflow really closes the request, that the document gate is
 * still in front of the single remaining Approve (D-6, the check that makes D-2
 * safe), and that a hand-written reassign cannot route around the switch (D-9).
 */

const findApplicationById = vi.fn();
const findOpenRequestForApplication = vi.fn();
const countUnverifiedRequiredDocuments = vi.fn();
const recordAction = vi.fn();
const updateApplication = vi.fn();
const updateApprovalRequest = vi.fn();
const activateApprovedApplication = vi.fn();
const queryRaw = vi.fn();

const tx = {
  $queryRaw: (...a: unknown[]) => queryRaw(...a),
  user: { findFirst: vi.fn() },
};

vi.mock('@db/prisma', () => ({
  prisma: { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) },
}));

vi.mock('@modules/application/application.repository', () => ({
  findApplicationById: (...a: unknown[]) => findApplicationById(...a),
  findOpenRequestForApplication: (...a: unknown[]) => findOpenRequestForApplication(...a),
  countUnverifiedRequiredDocuments: (...a: unknown[]) => countUnverifiedRequiredDocuments(...a),
  recordAction: (...a: unknown[]) => recordAction(...a),
  updateApplication: (...a: unknown[]) => updateApplication(...a),
  updateApprovalRequest: (...a: unknown[]) => updateApprovalRequest(...a),
  listFlaggedDocuments: vi.fn(async () => []),
  flagDocumentForReupload: vi.fn(),
}));

vi.mock('@modules/application/activation.service', () => ({
  activateApprovedApplication: (...a: unknown[]) => activateApprovedApplication(...a),
}));

vi.mock('@modules/application/application.tokens', () => ({
  issueApplicationAccessToken: vi.fn(async () => ({ url: 'https://example.test/resubmit' })),
  revokeApplicationAccessTokens: vi.fn(),
}));

vi.mock('@helpers/audit', () => ({ writeAudit: vi.fn() }));
vi.mock('@notifications/outbox', () => ({ queueNotifications: vi.fn() }));

const { approve, reassign } = await import('@modules/application/application.service');

const stage = (over: Partial<ApprovalStage> & { id: bigint; sequence: number }): ApprovalStage => ({
  workflow_id: 1n,
  name: `Stage ${over.sequence}`,
  approver_role_id: 1n,
  is_final: false,
  is_active: true,
  sla_hours: 48,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

/** The seeded configuration: only Final approval takes part (D-2). */
const DOCUMENT_VERIFICATION = stage({
  id: 11n,
  sequence: 1,
  name: 'Document verification',
  is_active: false,
});
const COMMITTEE_REVIEW = stage({
  id: 12n,
  sequence: 2,
  name: 'Committee review',
  is_active: false,
});
const FINAL_APPROVAL = stage({ id: 13n, sequence: 3, name: 'Final approval', is_final: true });
const STAGES = [DOCUMENT_VERIFICATION, COMMITTEE_REVIEW, FINAL_APPROVAL];

const APPLICATION = {
  id: 5n,
  application_number: 'APP2026030024',
  company_name: 'Acme Exports',
  status: 'UNDER_REVIEW',
  user_id: 2n,
  member_id: null,
  resubmission_count: 0,
};

// A super admin, which is who owns Final approval and who decides everything
// today — the reason two of the three stages are switched off in the first place.
const actor = {
  id: 7n,
  roles: ['SUPER_ADMIN'],
  isSuperAdmin: true,
  ip: null,
  userAgent: null,
  requestId: null,
};

const openRequestAt = (current: ApprovalStage) => ({
  id: 3n,
  current_stage: { ...current, approver_role: { code: 'SUPER_ADMIN' } },
  workflow: { id: 1n, stages: STAGES },
});

beforeEach(() => {
  vi.clearAllMocks();
  findApplicationById.mockResolvedValue(APPLICATION);
  findOpenRequestForApplication.mockResolvedValue(openRequestAt(FINAL_APPROVAL));
  countUnverifiedRequiredDocuments.mockResolvedValue(0);
  updateApplication.mockImplementation(async (_db, _id, data) => ({ ...APPLICATION, ...data }));
  activateApprovedApplication.mockResolvedValue({
    memberCode: 'ILGDA0031',
    invoiceNumber: 'IN202603001',
    totalAmount: '23600.00',
  });
});

describe('approve at the single active stage', () => {
  it('sets APPROVED and leaves no queue behind', async () => {
    await approve(5n, {}, actor);

    expect(updateApplication.mock.calls[0][2]).toMatchObject({
      status: 'APPROVED',
      current_stage: { disconnect: true },
    });
    // Nothing follows Final approval, so the request ends here rather than being
    // moved on to a stage nobody is watching.
    expect(updateApprovalRequest.mock.calls[0][2]).toMatchObject({ status: 'APPROVED' });
    expect(activateApprovedApplication).toHaveBeenCalledOnce();
  });

  it('moves an application parked on a switched-off stage into the live queue', async () => {
    // APP2026030024 sits on Committee review, switched off under it. Approving
    // must move it rather than error, with no data migration behind it (D-4):
    // stage 2 is off, so the next active stage — Final approval — takes it.
    findOpenRequestForApplication.mockResolvedValue(openRequestAt(COMMITTEE_REVIEW));

    await approve(5n, {}, actor);

    expect(updateApplication.mock.calls[0][2]).toMatchObject({
      status: 'UNDER_REVIEW',
      current_stage: { connect: { id: 13n } },
    });
    // The action is recorded against the stage the reviewer actually decided at,
    // switched off or not: that is where the decision happened.
    expect(recordAction.mock.calls[0][1]).toMatchObject({ stage_id: 12n, action: 'APPROVE' });
  });
});

describe('the document gate with Document verification switched off', () => {
  it('still refuses an approve while a required document is unverified', async () => {
    // The case D-2 rests on. The stage named after the check is off; the check
    // is not, because it never lived at that stage — it runs on every approve.
    countUnverifiedRequiredDocuments.mockResolvedValue(2);

    await expect(approve(5n, {}, actor)).rejects.toMatchObject({
      messageKey: 'application.documentsNotVerified',
      details: { outstanding: 2 },
    });

    expect(updateApplication).not.toHaveBeenCalled();
    expect(recordAction).not.toHaveBeenCalled();
    expect(activateApprovedApplication).not.toHaveBeenCalled();
  });
});

describe('reassign', () => {
  it('refuses a switched-off stage as a target', async () => {
    // The dialog does not offer Committee review, but a direct POST can name it
    // (D-9), and the application would then sit in an empty queue forever.
    await expect(
      reassign(5n, { stage_id: '12', remarks: 'Please take a look' }, actor),
    ).rejects.toMatchObject({ messageKey: 'application.stageNotInWorkflow' });

    expect(updateApplication).not.toHaveBeenCalled();
  });

  it('moves the application to an active stage', async () => {
    findOpenRequestForApplication.mockResolvedValue(openRequestAt(COMMITTEE_REVIEW));

    await expect(
      reassign(5n, { stage_id: '13', remarks: 'Over to you' }, actor),
    ).resolves.toBeDefined();

    expect(updateApplication.mock.calls[0][2]).toMatchObject({
      status: 'UNDER_REVIEW',
      current_stage: { connect: { id: 13n } },
    });
  });
});
