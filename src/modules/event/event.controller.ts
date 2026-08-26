import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/event/event.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/**
 * HTTP layer for events.
 *
 * BigInt and Decimal do not survive `JSON.stringify`, and the encryption layer
 * stringifies the payload before any custom replacer would run — so both are
 * normalised to strings here rather than left to leak as `[object Object]`.
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

const serialise = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, raw: unknown) => {
      if (typeof raw === 'bigint') return raw.toString();
      // Prisma.Decimal serialises as an object with a toString; the API contract
      // is a plain string so money never arrives as a shape the client must know.
      if (raw !== null && typeof raw === 'object' && 'toFixed' in raw) {
        return (raw as { toFixed: (dp: number) => string }).toFixed(2);
      }

      return raw;
    }),
  );

/** `POST /admin/events` — create a draft. */
export const createEvent = handler(async (req, res) => {
  const created = await service.createEvent(req.body as never, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'event.created',
    data: serialise(created),
  });
});

/** `PATCH /admin/events/:id` — edit details and re-price. */
export const updateEvent = handler(async (req, res) => {
  const updated = await service.updateEvent(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'event.updated',
    data: serialise(updated),
  });
});

/** `GET /admin/events/:id` — one event with its price table. */
export const getEvent = handler(async (req, res) => {
  const event = await service.getEvent(BigInt(req.params.id as string));

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(event) });
});

/** `GET /admin/events` — the paged admin list. */
export const listEvents = handler(async (req, res) => {
  const { rows, total } = await service.listEvents(req.query as never);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: {
      page: Number(req.query.page ?? 1),
      limit: Number(req.query.limit ?? 20),
      total,
    },
  });
});
