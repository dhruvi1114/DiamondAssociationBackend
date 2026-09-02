import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import { prisma } from '@db/prisma';
import * as memberRepo from '@modules/member/member.repository';
import { MEMBER_ROLE } from '@modules/member/team.constants';
import * as teamRepo from '@modules/member/team.repository';
import * as service from '@modules/member/team.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';
import { contextFromRequest } from '@modules/auth/auth.service';

/**
 * HTTP layer for company team logins.
 *
 * Like the rest of the member surface, no handler takes a company id from the
 * request — the firm is resolved from the token. An id in the path would let one
 * company edit another's roster (rbac.md §5).
 */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

export interface TeamContext {
  memberId: bigint;
  userId: bigint;
  isOwner: boolean;
}

/**
 * The company and role behind this request.
 *
 * Every team endpoint needs the same three facts and getting them wrong means
 * acting on someone else's roster, so the lookup lives here once rather than
 * being repeated per handler.
 */
const teamContext = async (req: Request): Promise<TeamContext> => {
  const userId = req.actor?.id;

  if (userId === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  const member = await memberRepo.findMemberByUserId(prisma, userId);

  if (!member) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.notFound' });
  }

  const row = await teamRepo.findTeamRowByUserId(prisma, member.id, userId);

  return { memberId: member.id, userId, isOwner: row?.member_role === MEMBER_ROLE.OWNER };
};

/**
 * Only the owner manages the roster.
 *
 * Finer team permissions are deliberately deferred, so this single guard is the
 * one place to widen when they are decided.
 */
const requireOwner = (context: TeamContext): void => {
  if (!context.isOwner) {
    throw new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey: 'member.teamOwnerOnly' });
  }
};

/** `GET /members/me/team` — the company's own roster. */
export const listTeam = handler(async (req, res) => {
  const context = await teamContext(req);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: { rows: await service.listTeam(context.memberId) },
  });
});

/**
 * `POST /members/me/contacts/:id/access` — give an existing contact a login.
 *
 * The people list is Contacts; access is granted onto somebody already on it,
 * which is why this takes a contact id and not a name and an email.
 */
export const grantContactAccess = handler(async (req, res) => {
  const context = await teamContext(req);

  requireOwner(context);

  const row = await service.grantContactAccess(
    BigInt(req.params.id),
    context,
    contextFromRequest(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'member.teamInvited',
    data: { row },
  });
});

/** `PATCH /members/me/contacts/:id/access` — switch that person's login on or off. Owner only. */
export const setContactAccess = handler(async (req, res) => {
  const context = await teamContext(req);

  requireOwner(context);

  const row = await service.setContactAccess(
    BigInt(req.params.id),
    req.body as never,
    context,
    contextFromRequest(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.teamStatusChanged',
    data: { row },
  });
});

/** `PATCH /members/me/team/:id/status` — switch a colleague on or off. Owner only. */
export const setTeamMemberStatus = handler(async (req, res) => {
  const context = await teamContext(req);

  requireOwner(context);

  const row = await service.setTeamMemberStatus(
    BigInt(req.params.id),
    req.body as never,
    context,
    contextFromRequest(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.teamStatusChanged',
    data: { row },
  });
});

export { teamContext, requireOwner };
