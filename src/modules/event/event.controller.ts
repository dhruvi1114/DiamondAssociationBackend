import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/event/event.service';
import * as eventPayment from '@modules/event/payment.service';
import * as registration from '@modules/event/registration.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';
import { prisma } from '@db/prisma';
import * as memberRepo from '@modules/member/member.repository';
import { resolveEventAccessToken } from '@modules/event/registration.tokens';
import { toWorkbook, XLSX_MIME } from '@helpers/excel';

/** Codes are what the wire carries; the caterer reading the file wants words. */
const FOOD_LABELS: Record<number, string> = { 0: 'Veg', 1: 'Non-veg', 2: 'Jain' };

const REGISTRATION_STATUS_LABELS: Record<number, string> = {
  0: 'Awaiting approval',
  1: 'Awaiting payment',
  2: 'Payment being verified',
  3: 'Confirmed',
  4: 'Expired',
  5: 'Cancelled',
  6: 'Rejected',
  7: 'Refunded',
};

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

/* --- offline payment: the claim, and the decision on it --------------------- */

/** `POST /events/registrations/:id/payment` — the payer says they have paid. */
export const submitPayment = handler(async (req, res) => {
  const result = await eventPayment.submitPayment(
    BigInt(req.params.id as string),
    req.body as never,
    {
      userId: req.actor?.id ?? null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
      requestId: req.requestId ?? null,
    },
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'event.paymentSubmitted',
    data: serialise(result),
  });
});

/** `POST /admin/payment-submissions/:id/verify` — staff confirm it landed. */
export const verifyPayment = handler(async (req, res) => {
  const result = await eventPayment.verifyPayment(BigInt(req.params.id as string), {
    adminId: actor(req).id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'event.paymentVerified',
    data: serialise(result),
  });
});

/** `POST /admin/payment-submissions/:id/reject` — staff could not find it. */
export const rejectPayment = handler(async (req, res) => {
  const result = await eventPayment.rejectPayment(
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
    messageKey: 'event.paymentRejected',
    data: serialise(result),
  });
});

/* --- guests: booking without an account ------------------------------------- */

/** `POST /public/events/:slug/register` — a non-member books a seat. No session. */
export const registerAsGuest = handler(async (req, res) => {
  const booking = await registration.registerAsGuest(req.params.slug as string, req.body as never, {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'event.registered',
    data: serialise(booking),
  });
});

/**
 * The booking a guest link opens, or 404.
 *
 * Every failure — unknown, expired, revoked, malformed — is the same 404.
 * Distinguishing them would tell whoever is guessing which guesses were close.
 */
const resolveBooking = async (token: string): Promise<bigint> => {
  const id = await resolveEventAccessToken(prisma, token);

  if (id === null) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'event.bookingLinkInvalid',
    });
  }

  return id;
};

/** `GET /public/events/booking/:token` — a guest looks at their own booking. */
export const getGuestBooking = handler(async (req, res) => {
  const id = await resolveBooking(req.params.token as string);
  const booking = await registration.getBookingSummary(id);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(booking) });
});

/** `POST /public/events/booking/:token/payment` — a guest says they have paid. */
export const submitGuestPayment = handler(async (req, res) => {
  const id = await resolveBooking(req.params.token as string);

  const result = await eventPayment.submitGuestPayment(id, req.body as never, {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'event.paymentSubmitted',
    data: serialise(result),
  });
});

/**
 * `GET /admin/events/:id/attendees/export` — the same list, as an Excel file.
 *
 * Same query, same filter, same order as the screen; only the rendering differs.
 * Codes become words, because the person opening this file is a caterer or a
 * receptionist, and "1" is not a dietary requirement.
 */
export const exportAttendees = handler(async (req, res) => {
  const eventId = BigInt(req.params.id as string);

  const [rows, event] = await Promise.all([
    registration.exportAttendees({ eventId, statuses: statusList(req.query.status) }),
    service.getEvent(eventId),
  ]);

  const workbook = await toWorkbook(
    rows,
    [
      { header: 'Name', value: (row) => row.full_name, width: 24 },
      { header: 'Designation', value: (row) => row.designation, width: 20 },
      { header: 'Organisation', value: (row) => row.booked_by, width: 28 },
      { header: 'Email', value: (row) => row.email, width: 28 },
      // Text, not a number: a phone number is not arithmetic, and as a number
      // Excel eats the leading zero and offers to render it in scientific
      // notation.
      { header: 'Phone', value: (row) => row.phone, width: 16 },
      { header: 'Member', value: (row) => (row.registrant_type === 0 ? 'Yes' : 'No'), width: 10 },
      // A number, so the office can total the column.
      { header: 'Fee', value: (row) => Number(row.unit_price), width: 12 },
      { header: 'Food', value: (row) => FOOD_LABELS[row.food_preference ?? -1] ?? '', width: 12 },
      { header: 'Special requirement', value: (row) => row.special_requirement, width: 30 },
      { header: 'Booking', value: (row) => row.registration_code, width: 18 },
      { header: 'Attendee code', value: (row) => row.attendee_code, width: 20 },
      {
        header: 'Status',
        value: (row) => REGISTRATION_STATUS_LABELS[row.status] ?? String(row.status),
        width: 22,
      },
    ],
    { sheetName: 'Attendees' },
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const safeTitle =
    event.title
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'event';

  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="attendees-${safeTitle}-${stamp}.xlsx"`,
  );
  res.status(200).send(workbook);
});
