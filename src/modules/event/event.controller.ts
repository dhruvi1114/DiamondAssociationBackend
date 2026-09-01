import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/event/event.service';
import * as media from '@modules/event/event.media.service';
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

/**
 * Translate the query string into the repository's filter shape.
 *
 * Ids become bigints and dates stay dates here, at the edge, so nothing further
 * in has to know that the wire carries strings.
 */
const browseFilters = (req: Request) => {
  const query = req.query as unknown as {
    page: number;
    limit: number;
    type?: string[];
    city?: string[];
    state?: string[];
    from?: Date;
    to?: Date;
    price?: 'free' | 'paid';
    open?: boolean;
    sort?: 'upcoming' | 'recent';
  };

  /*
    Every field is named twice on purpose — once as the query string spells it
    and once as the repository does — and every one of them has to be listed
    here. A filter added to the schema and the repository but not to this map is
    silently ignored: the request validates, the query runs, and nothing
    filters. That is exactly how `sort` shipped doing nothing.
  */
  return {
    page: query.page,
    limit: query.limit,
    typeIds: query.type?.map((id) => BigInt(id)),
    cities: query.city,
    states: query.state,
    from: query.from,
    to: query.to,
    price: query.price,
    openOnly: query.open,
    sort: query.sort,
  };
};

/** `GET /public/events/filters` · `GET /events/filters` — what the rail offers. */
export const eventFacets = handler(async (req, res) => {
  // No session on the public router, so `req.actor` is the whole difference:
  // a member's facets count the members-only events they can also see.
  const facets = await service.browseFacets(req.actor?.id === undefined);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(facets) });
});

/**
 * `GET /public/events/:slug/banner` · `GET /events/:slug/banner` — the poster.
 *
 * The event is read through the same visibility-aware reader the detail page
 * uses, so a members-only poster answers 404 to a stranger rather than 403 —
 * which would confirm the event exists.
 */
export const serveBanner = handler(async (req, res) => {
  const slug = req.params.slug as string;
  const event =
    req.actor?.id === undefined
      ? await service.getPublicEvent(slug)
      : await service.getMemberEvent(slug, req.actor.id);

  if (!event?.banner_url) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.bannerNotFound' });
  }

  const row = await prisma.event.findFirst({
    where: { slug, deletedAt: null },
    select: { banner_path: true },
  });

  if (!row?.banner_path) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.bannerNotFound' });
  }

  const file = await media.openBanner(row.banner_path);

  /*
    `no-cache` is "keep it, but ask every time", not "do not store": the poster
    is a mutable resource at a fixed URL, and an event switched to members-only
    must stop being served from a stranger's disk cache. The ETag makes the
    usual answer a 304 with no body.
  */
  const etag = `"${row.banner_path}"`;

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();

    return;
  }

  res.setHeader('Content-Disposition', 'inline');
  file.stream.pipe(res);
});

/** `GET /admin/events/:id/banner` — the staff copy, drafts included. */
export const serveAdminBanner = handler(async (req, res) => {
  const row = await prisma.event.findFirst({
    where: { id: BigInt(req.params.id as string), deletedAt: null },
    select: { banner_path: true },
  });

  if (!row?.banner_path) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.bannerNotFound' });
  }

  const file = await media.openBanner(row.banner_path);

  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  file.stream.pipe(res);
});

/** `POST /admin/events/:id/banner` */
export const uploadBanner = handler(async (req, res) => {
  if (!req.file) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'event.bannerRequired',
    });
  }

  await media.setBanner(
    BigInt(req.params.id as string),
    { buffer: req.file.buffer, originalname: req.file.originalname },
    actor(req).id,
  );

  handleApiResponse(res, { responseType: RES_STATUS.UPDATE, messageKey: 'event.bannerUpdated' });
});

/** `DELETE /admin/events/:id/banner` */
export const removeBanner = handler(async (req, res) => {
  await media.clearBanner(BigInt(req.params.id as string), actor(req).id);

  handleApiResponse(res, { responseType: RES_STATUS.DELETE, messageKey: 'event.bannerRemoved' });
});

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

/** `GET /public/events` — published public events. No session required. */
export const listPublicEvents = handler(async (req, res) => {
  const query = browseFilters(req);
  const { rows, total } = await service.listPublicEvents(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: { page: query.page, limit: query.limit, total },
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
  const query = browseFilters(req);
  const { rows, total } = await service.listMemberEvents(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: { page: query.page, limit: query.limit, total },
  });
});

/** `GET /events/:slug` — one published event, either visibility. */
export const getMemberEvent = handler(async (req, res) => {
  const event = await service.getMemberEvent(req.params.slug as string, req.actor?.id);

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

/**
 * A search term, or nothing.
 *
 * Trimmed, because a box the user has cleared to whitespace means "no filter",
 * and `%   %` matches nothing at all — an empty list that reads as a broken
 * screen rather than a cleared one.
 */
const searchTerm = (raw: unknown): string | undefined => {
  const value = typeof raw === 'string' ? raw.trim() : '';

  return value.length > 0 ? value : undefined;
};

/** `GET /admin/event-registrations/:id` — one booking, everything about it (A-23). */
export const getRegistration = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await registration.getRegistration(BigInt(req.params.id as string))),
  });
});

/** `GET /admin/event-registrations` — the booking list, and the approval queue. */
export const listRegistrations = handler(async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Math.min(Number(req.query.limit ?? 20), 100);

  const { rows, total } = await registration.listRegistrations({
    page,
    limit,
    eventId: req.query.event_id ? BigInt(req.query.event_id as string) : undefined,
    statuses: statusList(req.query.status),
    search: searchTerm(req.query.search),
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

/** `GET /admin/payment-submissions` — the claims waiting to be checked. */
export const listPaymentSubmissions = handler(async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Math.min(Number(req.query.limit ?? 20), 100);

  const { rows, total } = await eventPayment.listSubmissions({
    page,
    limit,
    statuses: statusList(req.query.status),
    methods: statusList(req.query.method),
    search: searchTerm(req.query.search),
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows }),
    pagination: { page, limit, total },
  });
});

/**
 * `GET /events/registrations/mine` — the company's own bookings.
 *
 * The company comes from the token. An id in the query would let one member read
 * another's bookings, which no amount of validation downstream can undo.
 */
export const listMyBookings = handler(async (req, res) => {
  const userId = req.actor?.id;

  if (userId === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  const member = await memberRepo.findMemberByUserId(prisma, userId);

  if (!member) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.notFound' });
  }

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({ rows: await registration.listMyBookings(member.id) }),
  });
});

/** `POST /events/registrations/:id/cancel` — a member calls off their own booking. */
export const cancelOwnBooking = handler(async (req, res) => {
  const userId = req.actor?.id;

  if (userId === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  const member = await memberRepo.findMemberByUserId(prisma, userId);

  if (!member) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.notFound' });
  }

  const result = await registration.cancelOwnBooking(BigInt(req.params.id as string), {
    userId,
    memberId: member.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  });

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'event.bookingCancelled',
    data: serialise(result),
  });
});
