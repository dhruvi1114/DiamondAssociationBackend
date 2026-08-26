import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/event/event.service';
import * as registration from '@modules/event/registration.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';
import { prisma } from '@db/prisma';
import * as memberRepo from '@modules/member/member.repository';

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

/**
 * `POST /admin/events/:id/publish` — make it visible.
 *
 * The response carries `audience_size` so the success message can confirm what
 * the confirmation dialog promised: "now visible to 1,240 members".
 */
export const publishEvent = handler(async (req, res) => {
  const result = await service.publishEvent(BigInt(req.params.id as string), actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'event.published',
    data: serialise(result),
  });
});

/** `POST /admin/events/:id/cancel` — call it off, with a mandatory reason. */
export const cancelEvent = handler(async (req, res) => {
  const result = await service.cancelEvent(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'event.cancelled',
    data: serialise(result),
  });
});

/** `DELETE /admin/events/:id` — remove an event nobody has booked. */
export const deleteEvent = handler(async (req, res) => {
  const result = await service.deleteEvent(BigInt(req.params.id as string), actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'event.deleted',
    data: serialise(result),
  });
});

/* --- browsing -------------------------------------------------------------- */

const pageQuery = (req: Request) => ({
  page: Number(req.query.page ?? 1),
  limit: Math.min(Number(req.query.limit ?? 20), 100),
});

/** `GET /public/events` — published public events. No session required. */
export const listPublicEvents = handler(async (req, res) => {
  const query = pageQuery(req);
  const { rows, total } = await service.listPublicEvents(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: { ...query, total },
  });
});

/**
 * `GET /public/events/:slug` — one public event.
 *
 * A members-only event is a 404, never a 403. The status code itself would
 * otherwise confirm the event exists, which is precisely what members-only means
 * it should not do.
 */
export const getPublicEvent = handler(async (req, res) => {
  const event = await service.getPublicEvent(req.params.slug as string);

  if (!event) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.notFound' });
  }

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(event) });
});

/** `GET /events` — published events of both kinds, for a signed-in member. */
export const listMemberEvents = handler(async (req, res) => {
  const query = pageQuery(req);
  const { rows, total } = await service.listMemberEvents(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: { ...query, total },
  });
});

/** `GET /events/:slug` — one published event, either visibility. */
export const getMemberEvent = handler(async (req, res) => {
  const event = await service.getMemberEvent(req.params.slug as string);

  if (!event) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.notFound' });
  }

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(event) });
});

/**
 * `POST /events/:slug/register` — a member books seats for its team.
 *
 * The company comes from the token, never from the body: an id in the body would
 * let one member book against another's account (rbac.md §5).
 */
export const registerForEvent = handler(async (req, res) => {
  const userId = req.actor?.id;

  if (userId === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  const member = await memberRepo.findMemberByUserId(prisma, userId);

  if (!member) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.notFound' });
  }

  const booking = await registration.registerAsMember(
    req.params.slug as string,
    req.body as never,
    {
      userId,
      memberId: member.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.requestId ?? null,
    },
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'event.registered',
    data: serialise(booking),
  });
});

/* --- staff: bookings and who is going to attend ----------------------------- */

const statusList = (raw: unknown): number[] | undefined =>
  typeof raw === 'string' && raw.length > 0 ? raw.split(',').map(Number) : undefined;

/** `GET /admin/event-registrations` — the booking list, and the approval queue. */
export const listRegistrations = handler(async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Math.min(Number(req.query.limit ?? 20), 100);

  const { rows, total } = await registration.listRegistrations({
    page,
    limit,
    eventId: req.query.event_id ? BigInt(req.query.event_id as string) : undefined,
    statuses: statusList(req.query.status),
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: { page, limit, total },
  });
});

/** `POST /admin/event-registrations/:id/approve`. */
export const approveRegistration = handler(async (req, res) => {
  const result = await registration.approveRegistration(BigInt(req.params.id as string), {
    adminId: actor(req).id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'event.registrationApproved',
    data: serialise(result),
  });
});

/** `POST /admin/event-registrations/:id/reject`. */
export const rejectRegistration = handler(async (req, res) => {
  const result = await registration.rejectRegistration(
    BigInt(req.params.id as string),
    req.body as never,
    {
      adminId: actor(req).id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.requestId ?? null,
    },
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'event.registrationRejected',
    data: serialise(result),
  });
});

/**
 * `GET /admin/events/:id/attendees` — who is going to attend.
 *
 * People, not companies. A row reading "ABC Pvt Ltd — 3" cannot be turned into
 * badges, a catering count or a door list.
 */
export const listAttendees = handler(async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Math.min(Number(req.query.limit ?? 100), 500);

  const { rows, total } = await registration.listAttendees({
    eventId: BigInt(req.params.id as string),
    page,
    limit,
    statuses: statusList(req.query.status),
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: { page, limit, total },
  });
});
