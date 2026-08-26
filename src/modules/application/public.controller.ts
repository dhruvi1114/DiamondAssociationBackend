import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/application/public.service';
import type {
  CorrectApplicationInput,
  ReopenApplicationInput,
  ResendLinkInput,
  ResetResubmissionsInput,
} from '@modules/application/public.types';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/**
 * HTTP layer for the login-free resubmit flow. Rules live in the service.
 *
 * The only thing worth noting here is what is *absent*: there is no `base(req)`
 * actor helper, because there is no actor. Every handler below takes its
 * authority from the token in the path and its identity from the application
 * that token resolves to, which is why none of them reads `req.actor`.
 */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

/** IP and user-agent, for the audit rows an anonymous correction still writes. */
const context = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
  requestId: req.requestId ?? null,
});

const tokenOf = (req: Request): string => req.params.token as string;

export const getApplication = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: await service.getByToken(tokenOf(req)),
  });
});

export const correctApplication = handler(async (req, res) => {
  const updated = await service.correctFields(
    tokenOf(req),
    req.body as CorrectApplicationInput,
    context(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'application.saved',
    data: updated,
  });
});

export const replaceDocument = handler(async (req, res) => {
  const file = req.file;

  if (!file) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'document.fileRequired',
    });
  }

  // Optional: a single-sided document does not need to say which face it is, and
  // a client that predates two-sided types will not send one.
  const rawSide = (req.query as { side?: unknown }).side;
  const side = rawSide === 'BACK' || rawSide === 'FRONT' ? rawSide : undefined;

  const updated = await service.replaceDocument(
    tokenOf(req),
    req.params.documentTypeCode as string,
    {
      originalName: file.originalname,
      buffer: file.buffer,
      declaredMime: file.mimetype,
    },
    context(req),
    side,
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'document.uploaded',
    data: updated,
  });
});

export const resubmit = handler(async (req, res) => {
  const updated = await service.resubmit(tokenOf(req), context(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'application.resubmitted',
    data: updated,
  });
});

/**
 * Always the same answer, whether or not the address matched.
 *
 * The message is written in the conditional — "if there is an application
 * waiting on you, the link is on its way" — so that saying it to a stranger is
 * true rather than merely uninformative.
 */
export const resendLink = handler(async (req, res) => {
  await service.resendLink((req.body as ResendLinkInput).email, context(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'application.linkResent',
  });
});

/* --- super admin ----------------------------------------------------------- */

export const resetResubmissions = handler(async (req, res) => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  const result = await service.resetResubmissionCount(
    BigInt(req.params.id as string),
    req.body as ResetResubmissionsInput,
    { id: req.actor.id, ...context(req) },
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'application.resubmissionsReset',
    data: result,
  });
});

/**
 * Reopen a closed application (D-18).
 *
 * The actor check is repeated rather than assumed: `requireSuperAdmin` has
 * already run, but this handler is the last place that can tell the service who
 * to write into the audit row, and an audit row for a reversal of a final
 * decision with a NULL actor is worse than no endpoint at all.
 */
export const reopenApplication = handler(async (req, res) => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  const result = await service.reopenApplication(
    BigInt(req.params.id as string),
    req.body as ReopenApplicationInput,
    { id: req.actor.id, ...context(req) },
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'application.reopened',
    data: result,
  });
});
