import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/directory/directory.service';
import type { ListDirectoryQuery } from '@modules/directory/directory.types';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const callerId = (req: Request): bigint => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return BigInt(req.actor.id);
};

const notFound = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'common.notFound' });

export const listDirectory = handler(async (req, res) => {
  const data = await service.list(callerId(req), req.query as unknown as ListDirectoryQuery);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data });
});

export const getDirectoryMember = handler(async (req, res) => {
  const data = await service.detail(callerId(req), String(req.params.slug));

  /*
    404 whether the company does not exist, is not ACTIVE, or opted out. A 403
    here would tell the caller which — and that a named company is a member of
    this association is itself something the directory does not disclose.
  */
  if (!data) throw notFound();

  handleApiResponse(res, { responseType: RES_STATUS.GET, data });
});

export const getFilters = handler(async (req, res) => {
  const data = await service.facets(callerId(req));

  handleApiResponse(res, { responseType: RES_STATUS.GET, data });
});

export const serveDirectoryLogo = handler(async (req, res) => {
  const { stream, mime } = await service.logo(callerId(req), BigInt(String(req.params.id)));

  res.setHeader('Content-Type', mime);
  /* Private: this image is entitlement-gated, so no shared cache may hold it. */
  res.setHeader('Cache-Control', 'private, max-age=300');
  stream.pipe(res);
});
