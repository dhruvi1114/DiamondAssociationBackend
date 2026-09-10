import { describe, expect, it } from 'vitest';
import type { ApprovalStage } from '@prisma/client';
import {
  assertStageSelectable,
  resolveApproval,
  stageForResubmission,
} from '@modules/application/approval.engine';

/**
 * The stage on/off switch (approval-stage-toggle spec §9).
 *
 * The three stages below are the seeded membership workflow, and the `sequence`
 * values are deliberately never renumbered when a stage is switched off (D-3) —
 * so every case here is really asking the same question: does the engine walk
 * the gaps correctly, or does it count?
 */
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

/** Document verification (1) and Committee review (2) off, Final approval (3) on — D-2. */
const SEEDED = [
  stage({ id: 11n, sequence: 1, name: 'Document verification', is_active: false }),
  stage({ id: 12n, sequence: 2, name: 'Committee review', is_active: false }),
  stage({ id: 13n, sequence: 3, name: 'Final approval', is_final: true }),
];

describe('resolveApproval with stages switched off', () => {
  it('approves outright when Final approval is the only active stage', () => {
    expect(resolveApproval(SEEDED, 13n)).toEqual({ isFinal: true, nextStage: null });
  });

  it('advances 1 → 3 across the gap left by a switched-off stage 2', () => {
    const withGap = [
      stage({ id: 11n, sequence: 1 }),
      stage({ id: 12n, sequence: 2, is_active: false }),
      stage({ id: 13n, sequence: 3, is_final: true }),
    ];

    const outcome = resolveApproval(withGap, 11n);

    expect(outcome.isFinal).toBe(false);
    // Sequence 2 is still there and still numbered 2. "Next" is the next stage
    // anybody is watching, not the next number.
    expect(outcome.nextStage?.id).toBe(13n);
  });

  it('moves an application parked on a switched-off stage to the next active one', () => {
    // APP2026030004 sits on Document verification, which was switched off under
    // it. It must not become undecidable (D-4).
    const parked = [
      stage({ id: 11n, sequence: 1, is_active: false }),
      stage({ id: 12n, sequence: 2, is_active: false }),
      stage({ id: 13n, sequence: 3 }),
    ];

    expect(resolveApproval(parked, 11n)).toMatchObject({ isFinal: false, nextStage: { id: 13n } });
  });

  it('approves an application parked on a switched-off stage when nothing active follows', () => {
    // The association moved its one live step earlier and switched the rest off.
    // The application on Committee review is behind nobody's queue now, and the
    // stage it sits on is not `is_final` — so it is the "no active stage after
    // this one" branch that has to approve it rather than strand it.
    const liveStepFirst = [
      stage({ id: 11n, sequence: 1, name: 'Document verification' }),
      stage({ id: 12n, sequence: 2, name: 'Committee review', is_active: false }),
      stage({ id: 13n, sequence: 3, name: 'Final approval', is_final: true, is_active: false }),
    ];

    expect(resolveApproval(liveStepFirst, 12n)).toEqual({ isFinal: true, nextStage: null });
  });

  it('still refuses a stage that is genuinely absent from the workflow', () => {
    // Switched off and missing are different: the first is a decision, the
    // second is a workflow that changed under a live application.
    expect(() => resolveApproval(SEEDED, 99n)).toThrowError(
      expect.objectContaining({ messageKey: 'application.stageNotInWorkflow' }),
    );
  });
});

describe('stageForResubmission', () => {
  it('skips switched-off stages and returns the first active one', () => {
    // Where a new, a resubmitted and a reopened application all start (D-5).
    expect(stageForResubmission(SEEDED).id).toBe(13n);
  });

  it('refuses a workflow with every stage switched off', () => {
    // Same conflict as a workflow with no stages at all (D-11): there is nobody
    // to send this to, and inventing a queue would be worse than saying so.
    const allOff = SEEDED.map((row) => ({ ...row, is_active: false }));

    expect(() => stageForResubmission(allOff)).toThrowError(
      expect.objectContaining({ messageKey: 'application.workflowHasNoStages' }),
    );
  });
});

describe('assertStageSelectable', () => {
  it('accepts an active stage', () => {
    expect(() => assertStageSelectable(SEEDED, 13n)).not.toThrow();
  });

  it('refuses a switched-off stage as a reassign target', () => {
    // A routing action must not park an application where nobody is looking
    // (D-9), even though the same stage is a perfectly valid place to BE.
    expect(() => assertStageSelectable(SEEDED, 12n)).toThrowError(
      expect.objectContaining({ messageKey: 'application.stageNotInWorkflow' }),
    );
  });

  it('refuses a stage from another workflow the same way', () => {
    expect(() => assertStageSelectable(SEEDED, 99n)).toThrowError(
      expect.objectContaining({ messageKey: 'application.stageNotInWorkflow' }),
    );
  });
});
