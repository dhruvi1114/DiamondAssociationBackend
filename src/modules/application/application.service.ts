import {
  ApplicationStatus,
  type ApprovalActionType,
  ApprovalRequestStatus,
  ApprovalSubjectType,
  Prisma,
  UserStatus,
} from '@prisma/client';
import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { generateDocumentNumber } from '@helpers/documentNumber';
import { getNumericSetting, SETTING_KEYS } from '@helpers/settings';
import { calendarQuarter } from '@helpers/documentNumber';
import { queueNotifications } from '@notifications/outbox';
import * as authRepo from '@modules/auth/auth.repository';
import { activateApprovedApplication } from '@modules/application/activation.service';
import * as engine from '@modules/application/approval.engine';
import * as repo from '@modules/application/application.repository';
import {
  issueApplicationAccessToken,
  revokeApplicationAccessTokens,
} from '@modules/application/application.tokens';
import * as memberRepo from '@modules/member/member.repository';
import * as memberService from '@modules/member/member.service';
import type {
  ApproveInput,
  ListApplicationsQuery,
  ReassignInput,
  RejectInput,
  SaveDraftInput,
} from '@modules/application/application.types';
import { AppError } from '@utils/appError';
import { describeSide, type DocumentSideValue } from '@modules/document/document.sides';
import { checklistFor } from '@modules/masters/masters.checklist';
/**
 * Applications and approval decisions (M4).
 *
 * Every reviewer decision follows the same shape, and the order is the point:
 *
 *   lock the request → re-read its state → check the actor owns this stage →
 *   check the transition is legal → write the action → move the subject →
 *   notify → audit
 *
 * Locking first is what makes two reviewers clicking Approve at the same moment
 * safe. Checking the stage before the transition is what stops a stage-1
 * approver deciding a stage-3 application.
 */

interface Actor {
  id: bigint;
  roles: string[];
  isSuperAdmin: boolean;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const notFound = (key: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: key });

const conflict = (key: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey: key });

const memberAudit = (actor: {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}) => ({
  actorType: 'MEMBER' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

const adminAudit = (actor: Actor) => ({
  actorType: 'ADMIN' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

/** `APP2026030001` — same shape as the invoice number, different prefix. */
const allocateApplicationNumber = (tx: Prisma.TransactionClient): Promise<string> => {
  const now = new Date();

  return generateDocumentNumber(tx, {
    prefix: 'APP',
    period: `${now.getUTCFullYear()}${String(calendarQuarter(now)).padStart(2, '0')}`,
    width: 4,
    separator: '',
  });
};

/* -------------------------------------------------------------------------- */
/* Applicant                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The applicant's current application, created on first use.
 *
 * One open application per user, enforced by a partial unique index as well as
 * here — two in-flight applications would give the committee two answers to one
 * question.
 */
export const getOrCreateDraft = async (
  userId: bigint,
  actor: { id: bigint; ip: string | null; userAgent: string | null; requestId: string | null },
) => {
  const existing = await repo.findOpenApplicationForUser(prisma, userId);
  if (existing) return existing;

  // ADR-016 says the member record exists from the moment the member journey
  // starts. Opening the profile provisions it; so must starting an application,
  // or the very first thing a new signup does returns 404.
  const member = await memberService.getOrCreateOwnMember(userId, actor);

  // A category is required to submit, not to start — the applicant picks one on
  // the first step of the form.
  const fallbackCategory = await prisma.membershipCategory.findFirst({
    where: { deletedAt: null, is_active: true },
    orderBy: { display_order: 'asc' },
  });
  if (!fallbackCategory) throw conflict('application.noCategoriesConfigured');

  const memberCategoryRows = await memberRepo.listMemberCategories(prisma, member.id);
  const primaryCategoryId = memberCategoryRows[0]?.category.id ?? fallbackCategory.id;

  return prisma.$transaction(async (tx) => {
    const created = await repo.createApplication(tx, {
      user_id: userId,
      member_id: member.id,
      category_id: primaryCategoryId,
      tier_id: null,
      company_name: member.company_name,
      legal_name: member.legal_name,
      business_type: null,
      iec_code: member.iec_code,
      gst_number: member.gst_number,
      pan_number: member.pan_number,
      trade_license_no: member.trade_license_no,
      website: member.website,
      about: member.about,
      status: ApplicationStatus.DRAFT,
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.APPLICATION_STARTED,
      entityName: 'MembershipApplications',
      entityId: created.id,
      after: { company_name: created.company_name },
    });

    return created;
  });
};

const assertOwnedAndEditable = async (applicationId: bigint, userId: bigint) => {
  const application = await repo.findApplicationById(prisma, applicationId);
  // Someone else's application is NOT FOUND, never FORBIDDEN — a 403 confirms
  // the id exists (rbac.md §5).
  if (!application || application.user_id !== userId) throw notFound('application.notFound');

  return application;
};

/**
 * Save a draft. Deliberately NOT audited: a form that autosaves on blur would
 * write an audit row per keystroke-pause, burying the decisions that matter in
 * noise. Submission is the audited event, and it captures the final content.
 */
export const saveDraft = async (applicationId: bigint, userId: bigint, input: SaveDraftInput) => {
  const application = await assertOwnedAndEditable(applicationId, userId);

  if (
    application.status !== ApplicationStatus.DRAFT &&
    application.status !== ApplicationStatus.RETURNED_FOR_CORRECTION
  ) {
    throw conflict('application.notEditable');
  }

  if (input.tier_id) {
    const tier = await prisma.membershipTier.findFirst({
      where: { id: BigInt(input.tier_id), deletedAt: null },
    });
    if (!tier) throw notFound('masters.tierNotFound');
    const categoryId = input.category_id ? BigInt(input.category_id) : application.category_id;
    if (tier.category_id !== categoryId) throw conflict('masters.tierCategoryMismatch');
  }

  return repo.updateApplication(prisma, applicationId, {
    ...(input.category_id !== undefined
      ? { category: { connect: { id: BigInt(input.category_id) } } }
      : {}),
    ...(input.tier_id !== undefined
      ? { tier: input.tier_id ? { connect: { id: BigInt(input.tier_id) } } : { disconnect: true } }
      : {}),
    ...(input.company_name !== undefined ? { company_name: input.company_name } : {}),
    ...(input.legal_name !== undefined ? { legal_name: input.legal_name } : {}),
    ...(input.business_type !== undefined ? { business_type: input.business_type } : {}),
    ...(input.iec_code !== undefined ? { iec_code: input.iec_code } : {}),
    ...(input.gst_number !== undefined ? { gst_number: input.gst_number } : {}),
    ...(input.pan_number !== undefined ? { pan_number: input.pan_number } : {}),
    ...(input.trade_license_no !== undefined ? { trade_license_no: input.trade_license_no } : {}),
    ...(input.website !== undefined ? { website: input.website } : {}),
    ...(input.about !== undefined ? { about: input.about } : {}),
  });
};

/** What is still missing, for the review step of the form. */
export const completeness = async (applicationId: bigint, userId: bigint) => {
  const application = await assertOwnedAndEditable(applicationId, userId);
  const [required, documents] = await Promise.all([
    checklistFor('APPLICATION'),
    repo.listApplicationDocuments(prisma, applicationId),
  ]);

  return engine.checkCompleteness(
    application as unknown as Record<string, unknown>,
    required,
    documents
      .filter((doc) => doc.verification_status !== 'REJECTED')
      .map((doc) => ({ code: doc.document_type.code, side: doc.side as DocumentSideValue })),
  );
};

/**
 * Submit, or resubmit after a return.
 *
 * The resubmission limit is checked *before* the work, so an applicant at the
 * limit is told immediately rather than after filling the form again.
 */
export const submit = async (
  applicationId: bigint,
  userId: bigint,
  actor: { id: bigint; ip: string | null; userAgent: string | null; requestId: string | null },
) => {
  const application = await assertOwnedAndEditable(applicationId, userId);
  engine.assertApplicantMay(application.status, ApplicationStatus.SUBMITTED);

  const isResubmission = application.status === ApplicationStatus.RETURNED_FOR_CORRECTION;
  if (isResubmission) {
    // Same fallback as the reject path. If the two disagreed, an applicant could
    // be invited to correct their application and then refused when they tried.
    const limit = await getNumericSetting(SETTING_KEYS.MAX_RESUBMISSIONS, 3);
    engine.assertResubmissionAllowed(application.resubmission_count, limit);
  }

  const result = await completeness(applicationId, userId);
  if (!result.complete) throw engine.incompleteError(result);

  const workflow = await repo.findActiveWorkflow(
    prisma,
    ApprovalSubjectType.MEMBERSHIP_APPLICATION,
  );
  if (!workflow || workflow.stages.length === 0) throw conflict('application.workflowHasNoStages');

  const firstStage = engine.stageForResubmission(workflow.stages);

  return prisma.$transaction(async (tx) => {
    const number = application.application_number ?? (await allocateApplicationNumber(tx));

    const updated = await repo.updateApplication(tx, applicationId, {
      status: ApplicationStatus.SUBMITTED,
      application_number: number,
      submitted_at: application.submitted_at ?? new Date(),
      current_stage: { connect: { id: firstStage.id } },
      ...(isResubmission ? { resubmission_count: { increment: 1 } } : {}),
    });

    const openRequest = await repo.findOpenRequestForApplication(tx, applicationId);
    if (openRequest) {
      // A returned application keeps its request; it simply goes back to stage 1.
      await repo.updateApprovalRequest(tx, openRequest.id, {
        status: ApprovalRequestStatus.OPEN,
        current_stage: { connect: { id: firstStage.id } },
      });
    } else {
      await repo.createApprovalRequest(tx, {
        workflow_id: workflow.id,
        subject_type: ApprovalSubjectType.MEMBERSHIP_APPLICATION,
        application_id: applicationId,
        current_stage_id: firstStage.id,
        status: ApprovalRequestStatus.OPEN,
      });
    }

    const applicant = await tx.user.findFirst({ where: { id: userId }, select: { email: true } });

    await queueNotifications(tx, ['EMAIL', 'IN_APP'], {
      templateCode: 'application.submitted',
      userId,
      memberId: application.member_id,
      toAddress: applicant?.email ?? null,
      payload: {
        company_name: application.company_name,
        application_number: number,
        stage_name: firstStage.name,
      },
    });

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.APPLICATION_SUBMITTED,
      entityName: 'MembershipApplications',
      entityId: applicationId,
      before: { status: application.status },
      after: {
        status: ApplicationStatus.SUBMITTED,
        application_number: number,
        resubmission: isResubmission,
      },
    });

    return updated;
  });
};

export const withdraw = async (
  applicationId: bigint,
  userId: bigint,
  actor: { id: bigint; ip: string | null; userAgent: string | null; requestId: string | null },
) => {
  const application = await assertOwnedAndEditable(applicationId, userId);
  engine.assertApplicantMay(application.status, ApplicationStatus.WITHDRAWN);

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateApplication(tx, applicationId, {
      status: ApplicationStatus.WITHDRAWN,
      decided_at: new Date(),
      current_stage: { disconnect: true },
    });

    const open = await repo.findOpenRequestForApplication(tx, applicationId);
    if (open) {
      await repo.updateApprovalRequest(tx, open.id, {
        status: ApprovalRequestStatus.WITHDRAWN,
        closed_at: new Date(),
      });
    }

    await writeAudit(tx, {
      ...memberAudit(actor),
      action: AUDIT_ACTIONS.APPLICATION_WITHDRAWN,
      entityName: 'MembershipApplications',
      entityId: applicationId,
      before: { status: application.status },
      after: { status: ApplicationStatus.WITHDRAWN },
    });

    return updated;
  });
};

export const listOwn = (userId: bigint) => repo.listApplicationsForUser(prisma, userId);

export const getOwnDetail = async (applicationId: bigint, userId: bigint) => {
  const application = await assertOwnedAndEditable(applicationId, userId);
  const detail = await repo.findApplicationDetail(prisma, application.id);
  if (!detail) throw notFound('application.notFound');

  return detail;
};

/* -------------------------------------------------------------------------- */
/* Reviewer                                                                    */
/* -------------------------------------------------------------------------- */

export const listForReview = async (query: ListApplicationsQuery, actor: Actor) => {
  const rows = await repo.listApplications(prisma, {
    search: query.search,
    statuses: query.status,
    stageIds: query.stage_id?.map(BigInt),
    categoryIds: query.category_id?.map(BigInt),
    // A super admin's "mine" is everything — they own every queue.
    myRoleCodes: query.mine && !actor.isSuperAdmin ? actor.roles : undefined,
    hasPendingDocuments: query.has_pending_documents,
    submittedFrom: query.submitted_from,
    submittedTo: query.submitted_to,
    cities: query.city,
    states: query.state,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  });

  return { rows, total: rows.length > 0 ? Number(rows[0]!.total) : 0 };
};

export const getDetailForReview = async (applicationId: bigint) => {
  const detail = await repo.findApplicationDetail(prisma, applicationId);
  if (!detail) throw notFound('application.notFound');

  return detail;
};

type Decision = 'approve' | 'reject' | 'reassign';

interface DecisionInput {
  remarks?: string | undefined;
  stageId?: bigint | undefined;
  /**
   * The ✗ marks the reviewer made in the Documents panel, rolled up into this
   * one decision (spec D-6, D-8). Empty or absent for a rejection that is about
   * the form rather than the files.
   */
  documents?: { id: string; remarks: string }[] | undefined;
}

/**
 * One reviewer decision.
 *
 * Everything below happens inside a single transaction that begins by locking
 * the approval request. A second reviewer arriving mid-flight blocks, re-reads
 * the state, and is told who decided first — instead of both advancing the
 * application by a stage each.
 *
 * There are two decisions here, not four (spec D-1). Reject absorbed Return
 * because the difference between them was never visible to the applicant, and
 * the choice it forced on the reviewer — "is this fatal?" — is not a judgement
 * about the application at all. It is arithmetic against a setting, and
 * `resolveRejection` does it.
 */
const decide = async (
  applicationId: bigint,
  decision: Decision,
  input: DecisionInput,
  actor: Actor,
) =>
  prisma.$transaction(async (tx) => {
    const application = await repo.findApplicationById(tx, applicationId);
    if (!application) throw notFound('application.notFound');

    const request = await repo.findOpenRequestForApplication(tx, applicationId);
    if (!request) throw conflict('application.alreadyDecided');

    await engine.lockApprovalRequest(tx, request.id);

    // Re-read AFTER the lock. Anything decided while we waited is now visible;
    // reading before the lock would use a stale snapshot.
    const fresh = await repo.findApplicationById(tx, applicationId);
    if (!fresh) throw notFound('application.notFound');
    if (engine.TERMINAL_STATUSES.includes(fresh.status))
      throw conflict('application.alreadyDecided');

    const stage = request.current_stage;
    if (!engine.canActOnStage(actor, { approver_role_code: stage.approver_role.code })) {
      throw engine.notYourQueue(stage.name, stage.approver_role.code);
    }

    const stages = request.workflow.stages;
    const now = new Date();
    let nextStatus: ApplicationStatus;
    let nextStageId: bigint | null = stage.id;
    let actionType: ApprovalActionType;
    /** Set only when the decision ends the request — approve-final or any reject. */
    let closeRequestWith: ApprovalRequestStatus | null = null;
    let activation: Awaited<ReturnType<typeof activateApprovedApplication>> | null = null;
    /** Which correction round this is, and how many are left. Reject path only. */
    let attempt = 0;
    let remaining: number | null = null;
    let cap = 0;

    if (decision === 'approve') {
      /*
       * Approve is blocked while any required document is unverified (spec D-7).
       * The admin screen disables the button for the same reason, but the screen
       * is a courtesy: without this check a direct POST could approve an
       * application whose GST certificate nobody had opened, and the whole first
       * stage of the workflow would be optional.
       */
      const outstanding = await repo.countUnverifiedRequiredDocuments(tx, applicationId);
      engine.assertRequiredDocumentsVerified(outstanding);

      const outcome = engine.resolveApproval(stages, stage.id);
      nextStatus = outcome.isFinal ? ApplicationStatus.APPROVED : ApplicationStatus.UNDER_REVIEW;
      nextStageId = outcome.isFinal ? null : outcome.nextStage.id;
      actionType = engine.ACTION_FOR.approve;
      closeRequestWith = outcome.isFinal ? engine.REQUEST_STATUS_FOR.approve : null;
      engine.assertReviewerMay(fresh.status, nextStatus);
    } else if (decision === 'reject') {
      /*
       * Which of the two rejections this is comes from the count, never from the
       * reviewer. `0` still means unlimited, in which case an application can be
       * sent back forever and REJECTED is unreachable — a configuration the
       * association may choose, and the seed no longer defaults to.
       */
      cap = await getNumericSetting(SETTING_KEYS.MAX_RESUBMISSIONS, 3);
      const resolved = engine.resolveRejection(fresh.resubmission_count, cap);

      attempt = engine.rejectionAttempt(fresh.resubmission_count);
      remaining = engine.attemptsRemaining(fresh.resubmission_count, cap);
      nextStatus = resolved;
      // Neither outcome leaves the application in a queue: one is waiting on the
      // applicant, the other is closed.
      nextStageId = null;
      actionType = engine.REJECTION_ACTION[resolved];
      closeRequestWith = engine.REJECTION_REQUEST_STATUS[resolved];
      engine.assertReviewerMay(fresh.status, nextStatus);
    } else {
      // Reassign moves the queue without deciding anything.
      if (!input.stageId) throw conflict('application.stageRequired');
      const target = stages.find((candidate) => candidate.id === input.stageId);
      if (!target) throw conflict('application.stageNotInWorkflow');
      nextStatus = ApplicationStatus.UNDER_REVIEW;
      nextStageId = target.id;
      actionType = engine.ACTION_FOR.reassign;
    }

    /*
     * The document marks travel WITH the decision (spec §4 step 5).
     *
     * This is the rule the old screen had to apologise for in prose: a document
     * decision never leaves the building on its own. The ✗ marks sit in the
     * reviewer's panel until this moment, and then one transaction flags them,
     * records the decision, closes the request and queues the single email that
     * carries all of it.
     */
    const flagged: {
      document_type: { code: string; name: string; sides: string };
      side: string;
      remarks: string | null;
    }[] = [];
    if (decision === 'reject' && input.documents && input.documents.length > 0) {
      for (const document of input.documents) {
        await repo.flagDocumentForReupload(
          tx,
          applicationId,
          BigInt(document.id),
          document.remarks,
          actor.id,
          now,
        );
      }

      flagged.push(...(await repo.listFlaggedDocuments(tx, applicationId)));
    }

    await repo.recordAction(tx, {
      approval_request_id: request.id,
      stage_id: stage.id,
      admin_user_id: actor.id,
      action: actionType,
      from_status: fresh.status,
      to_status: nextStatus,
      remarks: input.remarks ?? null,
    });

    const updated = await repo.updateApplication(tx, applicationId, {
      status: nextStatus,
      ...(nextStageId
        ? { current_stage: { connect: { id: nextStageId } } }
        : { current_stage: { disconnect: true } }),
      ...(engine.TERMINAL_STATUSES.includes(nextStatus) ? { decided_at: now } : {}),
    });

    if (nextStageId !== null) {
      await repo.updateApprovalRequest(tx, request.id, {
        current_stage: { connect: { id: nextStageId } },
      });
    } else if (closeRequestWith) {
      await repo.updateApprovalRequest(tx, request.id, {
        status: closeRequestWith,
        closed_at: now,
      });
    }

    // The whole point of the cycle: a final approval turns the form into a
    // member, a term and an invoice, inside this same transaction.
    if (nextStatus === ApplicationStatus.APPROVED) {
      activation = await activateApprovedApplication(tx, updated, actor);
    }

    /*
     * The applicant's way back in.
     *
     * There is no login to send them to — registration creates no password
     * before final approval (spec D-10) — so the link IS the way back, reissued
     * on every rejection so the newest email is always the one that works. Both
     * terminal endings revoke it: an approved application has nothing left to
     * correct, and a closed one must not offer a form that would be refused.
     */
    let resubmitUrl: string | null = null;
    if (nextStatus === ApplicationStatus.RETURNED_FOR_CORRECTION) {
      resubmitUrl = (await issueApplicationAccessToken(tx, applicationId)).url;
    } else if (
      nextStatus === ApplicationStatus.APPROVED ||
      nextStatus === ApplicationStatus.REJECTED
    ) {
      await revokeApplicationAccessTokens(tx, applicationId);
    }

    /*
     * A final rejection closes the LOGIN as well as the application (spec D-19).
     *
     * Registration leaves the account `PENDING_APPROVAL` with no password, and
     * that status is a dead end in both directions: `auth.service.ts` refuses to
     * sign in a `PENDING_APPROVAL` user, and `register.service.ts` silently
     * returns for one, so re-applying does nothing at all. An applicant refused
     * at the cap was therefore locked out of the association forever, by an
     * address they own, with no error message anywhere to explain it.
     *
     * `INACTIVE` is the status that says "this account has no live claim on
     * anything" without saying "this person is barred" (`BLOCKED`), and it is
     * the state `register.service.ts` now recognises as "may apply again". The
     * closure email already tells them to.
     *
     * Sessions are revoked with it. A rejected applicant has no password and so
     * almost certainly no session — but "almost certainly" is not a security
     * argument, and the one account that does have one (an old member who was
     * re-applying) must not keep a live token against a deactivated login.
     */
    if (nextStatus === ApplicationStatus.REJECTED) {
      await authRepo.updateUser(tx, fresh.user_id, { status: UserStatus.INACTIVE });
      await authRepo.revokeAllAuthTokens(tx, { userId: fresh.user_id });
    }

    const templateFor: Record<Decision, string | null> = {
      approve: nextStatus === ApplicationStatus.APPROVED ? null : 'application.stage_approved',
      // Two endings, two messages: one asks for a correction and carries the
      // link, the other says the application is closed and a fresh one is the
      // only way forward.
      reject:
        nextStatus === ApplicationStatus.REJECTED ? 'application.closed' : 'application.rejected',
      reassign: null,
    };
    const template = templateFor[decision];
    if (template) {
      const applicant = await tx.user.findFirst({
        where: { id: fresh.user_id },
        select: { id: true, email: true, full_name: true },
      });

      await queueNotifications(tx, ['EMAIL', 'IN_APP'], {
        templateCode: template,
        userId: fresh.user_id,
        memberId: fresh.member_id,
        toAddress: applicant?.email ?? null,
        payload: {
          company_name: fresh.company_name,
          application_number: fresh.application_number ?? '',
          // The reviewer's words reach the applicant verbatim — paraphrasing a
          // rejection is how "we need more detail" becomes "you were refused".
          remarks: input.remarks ?? '',
          stage_name: stage.name,
          // Itemised, so the applicant is not left comparing a paragraph against
          // three files to work out which two are wrong.
          document_reasons: flagged
            .map(
              (document) =>
                // The name from the master and the face, never a raw code — this
                // sentence is read by the applicant.
                `${describeSide(document.document_type.name, document.side as DocumentSideValue)}: ${
                  document.remarks ?? ''
                }`,
            )
            .join('\n'),
          document_count: String(flagged.length),
          attempt: String(attempt),
          max_resubmissions: String(cap),
          // Empty string rather than "unlimited": a template that prints nothing
          // is better than one that promises something the association may
          // change tomorrow.
          attempts_remaining: remaining === null ? '' : String(remaining),
          resubmit_url: resubmitUrl ?? '',
        },
      });
    }

    const auditAction = {
      approve:
        nextStatus === ApplicationStatus.APPROVED
          ? AUDIT_ACTIONS.APPLICATION_APPROVED
          : AUDIT_ACTIONS.APPLICATION_STAGE_APPROVED,
      // The audit trail keeps the distinction the button no longer makes: a
      // rejection that sent the application back and one that closed it are
      // different events to anyone reading the history later.
      reject:
        nextStatus === ApplicationStatus.REJECTED
          ? AUDIT_ACTIONS.APPLICATION_REJECTED
          : AUDIT_ACTIONS.APPLICATION_RETURNED,
      reassign: AUDIT_ACTIONS.APPLICATION_REASSIGNED,
    }[decision];

    await writeAudit(tx, {
      ...adminAudit(actor),
      action: auditAction,
      entityName: 'MembershipApplications',
      entityId: applicationId,
      before: { status: fresh.status, stage: stage.name },
      after: {
        status: nextStatus,
        remarks: input.remarks ?? null,
        ...(decision === 'reject'
          ? {
              attempt,
              max_resubmissions: cap,
              attempts_remaining: remaining,
              documents_flagged: flagged.length,
              // Recorded because the login moved with the application (D-19),
              // and a `Users.status` that changed with no row explaining it is
              // the kind of thing an audit trail exists to prevent.
              ...(nextStatus === ApplicationStatus.REJECTED
                ? { applicant_user_status: UserStatus.INACTIVE }
                : {}),
            }
          : {}),
        ...(activation
          ? {
              member_code: activation.memberCode,
              invoice_number: activation.invoiceNumber,
              total_amount: activation.totalAmount,
            }
          : {}),
      },
    });

    return { application: updated, activation };
  });

export const approve = (id: bigint, input: ApproveInput, actor: Actor) =>
  decide(id, 'approve', { remarks: input.remarks }, actor);

/**
 * The only action that sends an application back to the applicant.
 *
 * Whether "back" means "correct it and return" or "this is closed" is decided
 * inside, against `application.max_resubmissions`. The caller does not choose,
 * and neither does the reviewer.
 */
export const reject = (id: bigint, input: RejectInput, actor: Actor) =>
  decide(id, 'reject', { remarks: input.remarks, documents: input.documents }, actor);

export const reassign = (id: bigint, input: ReassignInput, actor: Actor) =>
  decide(id, 'reassign', { remarks: input.remarks, stageId: BigInt(input.stage_id) }, actor);

/**
 * The workflow as configured, for the read-only admin view (A-33).
 *
 * Carries `max_resubmissions` as well as the stages. The reviewer screens have
 * to say "Attempt 2 of 3" before the reviewer commits, and the cap lives in
 * `SystemSettings`, which only a super admin may read — so an ADMIN working
 * stage 1 could not fetch it for themselves. Riding along on the workflow, which
 * every reviewer screen already loads under `workflow.view`, hands them the one
 * number they need without opening the settings table to everybody.
 */
export const getWorkflow = async () => {
  const workflow = await repo.findActiveWorkflow(
    prisma,
    ApprovalSubjectType.MEMBERSHIP_APPLICATION,
  );
  if (!workflow) throw notFound('application.workflowHasNoStages');

  const maxResubmissions = await getNumericSetting(SETTING_KEYS.MAX_RESUBMISSIONS, 3);

  return { ...workflow, max_resubmissions: maxResubmissions };
};
