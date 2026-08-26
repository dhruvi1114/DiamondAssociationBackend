import {
  ApplicationStatus,
  ApprovalActionType,
  ApprovalRequestStatus,
  type ApprovalStage,
  type Prisma,
} from '@prisma/client';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { AppError } from '@utils/appError';
import {
  describeSide,
  type DocumentSideValue,
  missingSides,
} from '@modules/document/document.sides';
import type { ChecklistItem } from '@modules/masters/masters.checklist';
/**
 * The approval state machine.
 *
 * Kept apart from the service on purpose: these are the rules that decide
 * whether a decision is legal, and they are worth reading — and testing —
 * without the surrounding database work. The service does the transaction; this
 * file decides what the transaction is allowed to do.
 *
 * Configuration (how many stages, which role owns each) is data, not code
 * (`approval-workflow.md` §2). What is *not* configurable is the shape of the
 * machine below: an application cannot skip a stage, cannot be decided twice,
 * and cannot leave a terminal status.
 */

/** Statuses from which nothing further can happen. */
export const TERMINAL_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.APPROVED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
];

/** Statuses that count as "in flight" for the one-open-application rule. */
export const OPEN_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.DRAFT,
  ApplicationStatus.SUBMITTED,
  ApplicationStatus.UNDER_REVIEW,
  ApplicationStatus.RETURNED_FOR_CORRECTION,
];

/** What the applicant may do, and from where. */
const APPLICANT_TRANSITIONS: Partial<Record<ApplicationStatus, ApplicationStatus[]>> = {
  DRAFT: [ApplicationStatus.SUBMITTED, ApplicationStatus.WITHDRAWN],
  SUBMITTED: [ApplicationStatus.WITHDRAWN],
  UNDER_REVIEW: [ApplicationStatus.WITHDRAWN],
  RETURNED_FOR_CORRECTION: [ApplicationStatus.SUBMITTED, ApplicationStatus.WITHDRAWN],
};

/**
 * What a reviewer may do, and from where.
 *
 * Reject keeps BOTH targets. Since the reject/resubmit spec there is one Reject
 * button and two things it can mean — back to the applicant while attempts
 * remain, closed for good at the cap — and `resolveRejection` below decides
 * which. The table stays permissive on purpose: it says the move is legal from
 * here, not which of the two the count implies.
 */
const REVIEWER_TRANSITIONS: Partial<Record<ApplicationStatus, ApplicationStatus[]>> = {
  SUBMITTED: [
    ApplicationStatus.UNDER_REVIEW,
    ApplicationStatus.APPROVED,
    ApplicationStatus.REJECTED,
    ApplicationStatus.RETURNED_FOR_CORRECTION,
  ],
  UNDER_REVIEW: [
    ApplicationStatus.UNDER_REVIEW,
    ApplicationStatus.APPROVED,
    ApplicationStatus.REJECTED,
    ApplicationStatus.RETURNED_FOR_CORRECTION,
  ],
};

export const invalidTransition = (from: ApplicationStatus, to: ApplicationStatus): AppError =>
  new AppError({
    errorType: ERROR_TYPES.CONFLICT,
    messageKey: 'application.invalidTransition',
    code: 'INVALID_STATE_TRANSITION',
    replacements: { from, to },
    details: { from, to },
  });

export const assertApplicantMay = (from: ApplicationStatus, to: ApplicationStatus): void => {
  if (!(APPLICANT_TRANSITIONS[from] ?? []).includes(to)) throw invalidTransition(from, to);
};

export const assertReviewerMay = (from: ApplicationStatus, to: ApplicationStatus): void => {
  if (!(REVIEWER_TRANSITIONS[from] ?? []).includes(to)) throw invalidTransition(from, to);
};

/**
 * What an APPROVE at this stage means.
 *
 * The last stage approves the application; any earlier stage advances it. This
 * is the only place that decision is made, so "final" cannot mean one thing in
 * the service and another on screen.
 */
export const resolveApproval = (
  stages: ApprovalStage[],
  currentStageId: bigint,
): { isFinal: true; nextStage: null } | { isFinal: false; nextStage: ApprovalStage } => {
  const ordered = [...stages].sort((a, b) => a.sequence - b.sequence);
  const index = ordered.findIndex((stage) => stage.id === currentStageId);

  if (index === -1) {
    // The workflow changed under a live application. Better a loud conflict than
    // silently pushing it into a stage nobody configured.
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'application.stageNotInWorkflow',
    });
  }

  const current = ordered[index]!;
  const next = ordered[index + 1];

  if (current.is_final || !next) return { isFinal: true, nextStage: null };

  return { isFinal: false, nextStage: next };
};

/** The two things a Reject can resolve to. */
export type RejectionStatus =
  typeof ApplicationStatus.RETURNED_FOR_CORRECTION | typeof ApplicationStatus.REJECTED;

/**
 * What a REJECT at this moment means.
 *
 * There is one Reject button (spec D-1) because the reviewer's judgement is one
 * thing — "this is not good enough yet". Whether that ends the application is
 * not the reviewer's call; it is arithmetic on how many corrections the
 * association already allowed. So the button never asks, and this function
 * always answers.
 *
 * `used` is `resubmission_count` — corrections the applicant has ALREADY made.
 * It is not incremented here and not incremented by the reject transaction: the
 * counter moves when a resubmission actually arrives (`submit`), so the number
 * always means the same thing whichever side reads it.
 *
 * The predicate is deliberately identical to `assertResubmissionAllowed`: a
 * rejection sends the application back exactly when the applicant would be
 * allowed to resubmit it. Any drift between the two produces the worst possible
 * bug — an applicant told to correct their application and then refused when
 * they try.
 *
 * `limit` of `0` means unlimited, in which case nothing ever closes this way.
 */
export const resolveRejection = (used: number, limit: number): RejectionStatus =>
  limit > 0 && used >= limit
    ? ApplicationStatus.REJECTED
    : ApplicationStatus.RETURNED_FOR_CORRECTION;

/**
 * Which correction round a rejection is starting, 1-based.
 *
 * `used` corrections have happened, so the one being asked for now is the next.
 * This is the number the reviewer sees on the button ("Attempt 2 of 3") and the
 * applicant sees in the email, and it comes from here so the two cannot drift.
 */
export const rejectionAttempt = (used: number): number => used + 1;

/** How many corrections are left AFTER this rejection. `null` when unlimited. */
export const attemptsRemaining = (used: number, limit: number): number | null =>
  limit > 0 ? Math.max(limit - used, 0) : null;

/**
 * The action type a rejection records.
 *
 * `RETURN` survives the retirement of the Return *button* (spec D-1) because it
 * still describes what happened to the application, and because thousands of
 * historical rows already say it. What changed is who writes it: not a second
 * button, but the same Reject resolving under the cap.
 */
export const REJECTION_ACTION: Record<RejectionStatus, ApprovalActionType> = {
  [ApplicationStatus.RETURNED_FOR_CORRECTION]: ApprovalActionType.RETURN,
  [ApplicationStatus.REJECTED]: ApprovalActionType.REJECT,
};

/** The request status a rejection closes the approval request with. */
export const REJECTION_REQUEST_STATUS: Record<RejectionStatus, ApprovalRequestStatus> = {
  [ApplicationStatus.RETURNED_FOR_CORRECTION]: ApprovalRequestStatus.RETURNED,
  [ApplicationStatus.REJECTED]: ApprovalRequestStatus.REJECTED,
};

/**
 * May this application be approved yet?
 *
 * Approve is blocked while any REQUIRED document is unverified (spec D-7). The
 * admin screen disables the button for the same reason, but the screen is a
 * courtesy and this is the rule: a direct POST must not be able to approve an
 * application whose GST certificate nobody has read.
 *
 * The count is in the message because "some documents are unverified" sends the
 * reviewer back to the panel to hunt; "2 documents are not verified yet" tells
 * them what they are looking for.
 */
export const assertRequiredDocumentsVerified = (outstanding: number): void => {
  if (outstanding > 0) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'application.documentsNotVerified',
      code: 'DOCUMENTS_NOT_VERIFIED',
      replacements: { count: String(outstanding) },
      details: { outstanding },
    });
  }
};

/**
 * May this reviewer act on this stage?
 *
 * Holding `application.approve` is not enough — the permission says *what* they
 * may do, and the stage's role says *whose queue this is* (`rbac.md` §4).
 * Without the second check, an approver for stage 1 could decide a stage 3
 * application and skip the committee entirely.
 *
 * Super admins bypass, and that bypass is audited like any other action.
 */
export const canActOnStage = (
  actor: { roles: string[]; isSuperAdmin: boolean },
  stage: { approver_role_code: string },
): boolean => actor.isSuperAdmin || actor.roles.includes(stage.approver_role_code);

export const notYourQueue = (stageName: string, roleCode: string): AppError =>
  new AppError({
    errorType: ERROR_TYPES.FORBIDDEN,
    messageKey: 'application.notYourQueue',
    replacements: { stage: stageName, role: roleCode },
    details: { stage: stageName, required_role: roleCode },
  });

/**
 * Where a returned application goes when resubmitted.
 *
 * Back to the first stage, deliberately. A correction the applicant made at the
 * request of stage 3 may invalidate what stage 1 checked, and re-reading a
 * corrected form is cheaper than discovering later that nobody did.
 */
export const stageForResubmission = (stages: ApprovalStage[]): ApprovalStage => {
  const first = [...stages].sort((a, b) => a.sequence - b.sequence)[0];
  if (!first) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'application.workflowHasNoStages',
    });
  }

  return first;
};

/**
 * Has this applicant run out of resubmissions?
 *
 * The limit is a super-admin setting (`application.max_resubmissions`); `0`
 * means unlimited. Checked before the work, so the applicant is told they are
 * at the limit rather than after filling the form again.
 *
 * Kept alongside `resolveRejection` rather than folded into it: this is the
 * applicant's path and it must THROW, while the reviewer's path must decide
 * quietly and carry on. Same predicate, two different jobs.
 */
export const assertResubmissionAllowed = (used: number, limit: number): void => {
  if (limit > 0 && used >= limit) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'application.resubmissionLimitReached',
      replacements: { limit: String(limit) },
      details: { limit, used },
    });
  }
};

/** The fields an application cannot be submitted without. */
const REQUIRED_FIELDS = ['company_name', 'category_id'] as const;

export interface MissingDocument {
  code: string;
  name: string;
  side: DocumentSideValue;
  /** How it reads in a sentence — "Aadhaar Card (back)". */
  label: string;
}

export interface CompletenessResult {
  complete: boolean;
  missingFields: string[];
  missingDocuments: MissingDocument[];
}

/**
 * Is this application submittable?
 *
 * Returns everything that is missing rather than the first problem: a form that
 * rejects one field at a time turns submission into a guessing game
 * (ux-principles.md §5).
 *
 * Documents are compared as (type, face) pairs, not as codes. A two-sided type
 * with only its front uploaded is as incomplete as one with nothing, and the
 * applicant is told exactly which half is owed — the whole point of `sides`.
 *
 * Optional types are never counted. They are on the checklist so the applicant
 * CAN supply them, not so they must.
 */
export const checkCompleteness = (
  application: Record<string, unknown>,
  required: ChecklistItem[],
  supplied: Array<{ code: string; side: DocumentSideValue }>,
): CompletenessResult => {
  const missingFields = REQUIRED_FIELDS.filter((field) => {
    const value = application[field];

    return value === null || value === undefined || value === '';
  });

  const byCode = new Map<string, DocumentSideValue[]>();
  for (const item of supplied) {
    byCode.set(item.code, [...(byCode.get(item.code) ?? []), item.side]);
  }

  const missingDocuments = required
    .filter((type) => type.is_required)
    .flatMap((type) =>
      missingSides(type.sides, byCode.get(type.code) ?? []).map((side) => ({
        code: type.code,
        name: type.name,
        side,
        label: describeSide(type.name, side),
      })),
    );

  return {
    complete: missingFields.length === 0 && missingDocuments.length === 0,
    missingFields: [...missingFields],
    missingDocuments,
  };
};

export const incompleteError = (result: CompletenessResult): AppError =>
  new AppError({
    errorType: ERROR_TYPES.VALIDATION_ERROR,
    messageKey: 'application.incomplete',
    details: {
      fields: result.missingFields,
      // Readable labels, not codes — this payload is shown to the applicant.
      documents: result.missingDocuments.map((document) => document.label),
    },
  });

/**
 * The action type each reviewer decision records.
 *
 * Reject is absent because it has no single answer any more — it records
 * `REJECT` at the cap and `RETURN` below it. `REJECTION_ACTION`, keyed by the
 * resolved status rather than by the button, is where that lives.
 */
export const ACTION_FOR: Record<'approve' | 'reassign', ApprovalActionType> = {
  approve: ApprovalActionType.APPROVE,
  reassign: ApprovalActionType.REASSIGN,
};

/** The request status an approval closes its request with. See `REJECTION_REQUEST_STATUS`. */
export const REQUEST_STATUS_FOR: Record<'approve', ApprovalRequestStatus> = {
  approve: ApprovalRequestStatus.APPROVED,
};

/**
 * Lock the approval request before reading its state.
 *
 * Two reviewers opening the same application and clicking Approve within a
 * second of each other is not hypothetical — it is a committee meeting. Without
 * the lock both read `UNDER_REVIEW`, both advance a stage, and the application
 * skips one. With it, the second waits, re-reads, and gets a 409 naming who
 * decided first.
 */
export const lockApprovalRequest = async (
  tx: Prisma.TransactionClient,
  requestId: bigint,
): Promise<void> => {
  await tx.$queryRaw`SELECT id FROM "ApprovalRequests" WHERE id = ${requestId} FOR UPDATE`;
};
