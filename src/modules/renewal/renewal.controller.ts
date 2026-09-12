import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import * as admin from '@modules/renewal/renewal.admin.service';
import * as member from '@modules/renewal/renewal.member.service';
import type { BucketListQuery, SwitchPlanBody } from '@modules/renewal/renewal.types';
import * as memberService from '@modules/member/member.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/** HTTP layer for the admin renewals queue (A-20) and the member's own term. */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

/**
 * The caller, for the audit trail — same shape and same guard as
 * `member.controller.ts`'s `actor(req)`, which builds what it passes into
 * `recordInvoicePayment`.
 */
const actor = (req: Request) => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return {
    id: req.actor.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
};

/**
 * The admin actor → audit fields, same mapping `member.service.ts`'s private
 * `adminAudit` applies to the `Actor` `member.controller.ts` builds — that
 * helper is not exported, so the run-now controller (which writes its own
 * audit row rather than going through a service) reproduces the mapping here
 * instead of duplicating a second `actor()` extractor.
 */
const adminAuditFrom = (req: Request) => {
  const current = actor(req);

  return {
    actorType: ACTOR_TYPES.ADMIN,
    actorId: current.id,
    ip: current.ip,
    userAgent: current.userAgent,
    requestId: current.requestId,
  };
};

/* --- admin: A-20 renewals queue --------------------------------------------- */

export const getAdminSummary = handler(async (_req, res) => {
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: await admin.getSummary() });
});

export const listAdminBucket = handler(async (req, res) => {
  const { data, pagination } = await admin.listBucket(req.query as unknown as BucketListQuery);
  handleApiResponse(res, { responseType: RES_STATUS.GET, data, pagination });
});

/** `POST /admin/renewals/run` — "Generate Invoices": run the renewal cycle now. */
export const runAdminCycle = handler(async (req, res) => {
  const summary = await admin.runNow();

  await writeAudit(prisma, {
    ...adminAuditFrom(req),
    action: AUDIT_ACTIONS.RENEWAL_RUN,
    entityName: 'MembershipTerms',
    entityId: null,
    before: null,
    after: { raised: summary.raised, skipped: summary.skipped.length, expired: summary.expired },
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'renewal.runCompleted',
    data: summary,
  });
});

/* --- member: C-18/C-23 own term --------------------------------------------- */

/** The caller's own company, auto-provisioned on first access — same as `member.controller.ts`. */
const ownMember = async (req: Request) => {
  const current = actor(req);

  return memberService.getOrCreateOwnMember(current.id, current);
};

export const getMyTerm = handler(async (req, res) => {
  const own = await ownMember(req);
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: await member.getMyTermView(own.id),
  });
});

export const listMyTerms = handler(async (req, res) => {
  const own = await ownMember(req);
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: await member.listMyTerms(own.id) });
});

export const listMyRenewalPlans = handler(async (req, res) => {
  const own = await ownMember(req);
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: await member.listMyRenewalPlans(own.id),
  });
});

export const switchMyRenewalPlan = handler(async (req, res) => {
  const own = await ownMember(req);
  const current = actor(req);
  const { fee_plan_id } = req.body as SwitchPlanBody;

  const data = await member.switchRenewalPlan(own.id, BigInt(fee_plan_id), {
    actorId: current.id,
    ip: current.ip,
    userAgent: current.userAgent,
    requestId: current.requestId,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'renewal.planChanged',
    data,
  });
});

/** `POST /membership/me/renewal/decline` — "I don't want to renew" (Task 17). */
export const declineMyRenewal = handler(async (req, res) => {
  const own = await ownMember(req);
  const current = actor(req);

  const data = await member.declineRenewal(own.id, {
    actorId: current.id,
    ip: current.ip,
    userAgent: current.userAgent,
    requestId: current.requestId,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'renewal.declined',
    data,
  });
});

/** `POST /membership/me/renewal/resume` — "Renew after all" (Task 17). */
export const resumeMyRenewal = handler(async (req, res) => {
  const own = await ownMember(req);
  const current = actor(req);

  const data = await member.resumeRenewal(own.id, {
    actorId: current.id,
    ip: current.ip,
    userAgent: current.userAgent,
    requestId: current.requestId,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'renewal.resumed',
    data,
  });
});
