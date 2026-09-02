import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/billing/refund.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/** HTTP layer for the refund queue (A-5). Every route sits behind `refund.manage`. */

/*
  The presenter already turns money into strings and ids into strings, so this
  only has to catch the BigInt and Decimal values that travel inside a nested
  Prisma row. Same shape as the events controller's, deliberately: two different
  answers to "how does money leave this API" is one too many.
*/
const serialise = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, raw: unknown) => {
      if (typeof raw === 'bigint') return raw.toString();
      if (raw !== null && typeof raw === 'object' && 'toFixed' in raw) {
        return (raw as { toFixed: (dp: number) => string }).toFixed(2);
      }

      return raw;
    }),
  );

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const actor = (req: Request): service.RefundActor => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return {
    adminId: req.actor.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
};

/** `GET /admin/refunds` — the queue, filtered by where each refund has got to. */
export const listRefunds = handler(async (req, res) => {
  const { rows, total, page, limit } = await service.listRefunds(req.query as never);

  handleApiResponse(res, {
    // The array itself, not `{ rows }`. Every admin list on this API answers
    // with a bare array and its pagination beside it, and the tables are built
    // to receive one — a wrapped object arrives at antd's Table as a non-array
    // `dataSource` and takes the whole screen down.
    responseType: RES_STATUS.GET,
    data: serialise(rows),
    pagination: { page, limit, total },
  });
});

/** `POST /admin/refunds/:id/approve` — released for sending. */
export const approveRefund = handler(async (req, res) => {
  const row = await service.approveRefund(BigInt(req.params.id as string), actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'billing.refundApproved',
    data: serialise(row),
  });
});

/** `POST /admin/refunds/:id/reject` — refused, with a reason the payer is given. */
export const rejectRefund = handler(async (req, res) => {
  const row = await service.rejectRefund(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'billing.refundRejected',
    data: serialise(row),
  });
});

/** `POST /admin/refunds/:id/complete` — the money went back, with the bank reference. */
export const completeRefund = handler(async (req, res) => {
  const row = await service.completeRefund(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'billing.refundCompleted',
    data: serialise(row),
  });
});

/** `POST /admin/refunds/:id/fail` — the transfer bounced. */
export const failRefund = handler(async (req, res) => {
  const row = await service.failRefund(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'billing.refundFailed',
    data: serialise(row),
  });
});
