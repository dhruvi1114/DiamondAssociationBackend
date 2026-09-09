import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/masters/masters.feePlans.service';
import type { StructureListQuery } from '@modules/masters/masters.feePlans.types';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/**
 * HTTP layer for the redesigned price list. Parses, delegates, responds — every rule lives in
 * the service (RULES.md).
 */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

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

/** BigInt ids and Decimal money do not survive `JSON.stringify` — normalise both. */
const serialise = <T>(value: T): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Date) return val.toISOString();

      return val;
    }),
  );

export const listStructures = handler(async (req, res) => {
  const query = req.query as unknown as StructureListQuery;
  const { data, total } = await service.listStructures(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(data),
    pagination: { page: query.page, limit: query.limit, total },
  });
});

export const getStructure = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await service.getStructure(BigInt(req.params.id as string))),
  });
});

export const createStructure = handler(async (req, res) => {
  const created = await service.createStructure(req.body as never, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.feePlanStructureCreated',
    data: serialise(created),
  });
});

export const updateStructure = handler(async (req, res) => {
  const body = req.body as { is_active?: boolean };

  /*
    One PATCH, two jobs: retiring is a single boolean and repricing is the whole grid. Splitting
    them into two endpoints would have the screen choose which to call, and the screen has no
    business knowing that a retire is not a save.
  */
  if (typeof body.is_active === 'boolean' && Object.keys(body).length === 1) {
    const updated = await service.setStructureActive(
      BigInt(req.params.id as string),
      body.is_active,
      actor(req),
    );
    handleApiResponse(res, {
      responseType: RES_STATUS.UPDATE,
      messageKey: body.is_active
        ? 'masters.feePlanStructureRestored'
        : 'masters.feePlanStructureRetired',
      data: serialise(updated),
    });

    return;
  }

  const updated = await service.updateStructure(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.feePlanStructureUpdated',
    data: serialise(updated),
  });
});

/** The public membership page — live plans of the live list, nothing else. */
export const listPublicPlans = handler(async (_req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await service.listPublicPlans()),
  });
});
