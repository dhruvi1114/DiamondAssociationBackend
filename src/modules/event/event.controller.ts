import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { MSG_KEYS, RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/event/event.service';
import * as media from '@modules/event/event.media.service';
import * as eventPayment from '@modules/event/payment.service';
import * as registration from '@modules/event/registration.service';
import * as lookupService from '@modules/event/booking.lookup.service';
import { verifyBookingLookupToken } from '@modules/event/booking.lookup.tokens';
import * as memberService from '@modules/member/member.service';
import { AppError } from '@utils/appError';
import { bearerToken } from '@utils/jwt';
import { handleApiResponse } from '@utils/handleResponse';
import { prisma } from '@db/prisma';
import * as memberRepo from '@modules/member/member.repository';
import { EVENT_STATUS } from '@modules/event/event.constants';
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

/**
 * `GET /public/events/filters` · `GET /events/filters` — what the rail offers.
 *
 * Mounted on both routers, so `req.actor` may or may not exist. Presence of a
 * token is not the test, though: an approved member who has not paid their
 * invoice gets `req.actor` from the member router's `authenticate` middleware
 * same as anyone else, but must see the same (public-only) facet counts as a
 * guest. `resolveMemberBenefits` — the one place this rule lives — decides.
 */
export const eventFacets = handler(async (req, res) => {
  const publicOnly =
    req.actor?.id === undefined ? true : !(await service.resolveMemberBenefits(req.actor.id));
  const facets = await service.browseFacets(publicOnly);

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

  /*
    The poster is served for any PUBLISHED event, members-only included, and
    deliberately does NOT go through `getPublicEvent`.

    `bannerUrl` (event.media.ts) always emits the PUBLIC banner path, even in a
    response built for a member — so routing this through the public-visibility
    filter made a members-only event's poster 404 for EVERYONE, including the
    members it was listed to. The card showed an empty grey box beside a title
    and a price it had just rendered.

    Serving it is the narrow exception, taken deliberately (user decision,
    2026-09-10). Everything else about a members-only event stays absent from
    every public query: it is not listed, not searched, not counted in the
    filter rail, and `getPublicEvent` still refuses it. What is exposed here is
    one marketing image, at a URL containing a slug with a random suffix, whose
    bytes carry no event data — no date, no venue, no price, not even the title.

    DRAFT and CANCELLED events are still refused: a poster for something never
    published, or since called off, is not a picture anybody should be handed.
  */
  const row = await prisma.event.findFirst({
    where: { slug, deletedAt: null, status: EVENT_STATUS.PUBLISHED },
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

/**
 * `GET /events` — published events, for a signed-in member.
 *
 * Member-only events are included only when this caller currently has member
 * benefits (see `resolveMemberBenefits`) — an approved member who has not
 * paid their invoice sees the public set, exactly like a guest.
 */
export const listMemberEvents = handler(async (req, res) => {
  const query = browseFilters(req);
  const publicOnly =
    req.actor?.id === undefined ? true : !(await service.resolveMemberBenefits(req.actor.id));
  const { rows, total } = await service.listMemberEvents(query, publicOnly);

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

/**
 * The receipt off a multipart claim, or a 422 naming the field.
 *
 * Required, so this is a guard rather than a lookup. Multer has already applied
 * the size ceiling; the bytes are sniffed further in, when the file is stored.
 */
const requiredProof = (req: Request): { buffer: Buffer; originalname: string } => {
  if (!req.file) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: MSG_KEYS.VALIDATION_FAILED,
      details: { fields: { proof: 'billing.proofRequired' } },
    });
  }

  return req.file;
};

/** `POST /events/registrations/:id/payment` — the payer says they have paid. */
export const submitPayment = handler(async (req, res) => {
  const result = await eventPayment.submitPayment(
    BigInt(req.params.id as string),
    req.body as never,
    requiredProof(req),
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

/** `POST /public/events/booking/request-otp` — send a guest booking verification code. */
export const requestBookingOtp = handler(async (req, res) => {
  await registration.requestBookingOtp(req.body.email);

  handleApiResponse(res, { responseType: RES_STATUS.ACTION, messageKey: 'auth.otpSent' });
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

  const result = await eventPayment.submitGuestPayment(id, req.body as never, requiredProof(req), {
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
 * Stream a claim's receipt to staff or to the company that filed it.
 *
 * `attachment`, like every other file this API serves: a PDF or image that
 * renders in the tab it was fetched from is a document executing in this
 * origin's context. Entitlement is decided in the service, and a stranger gets
 * 404 rather than 403 so ids cannot be probed.
 */
export const downloadPaymentProof = handler(async (req, res) => {
  const isAdmin = req.actor?.type === 'ADMIN';

  const file = await eventPayment.openProofForDownload(BigInt(req.params.id as string), {
    userId: isAdmin ? null : (req.actor?.id ?? null),
    isAdmin,
  });

  res.setHeader('Content-Type', file.mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename.replace(/["\r\n]/g, '')}"`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  file.stream.pipe(res);
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

/* --- guests: "find my bookings" (D-3, D-6) ----------------------------------- */

/** `POST /public/events/bookings/lookup/request-otp` — send a lookup code. */
export const requestLookupOtp = handler(async (req, res) => {
  await lookupService.requestLookupOtp(req.body.email);

  handleApiResponse(res, { responseType: RES_STATUS.ACTION, messageKey: 'auth.otpSent' });
});

/** `POST /public/events/bookings/lookup` — every booking made with one email. */
export const lookupBookings = handler(async (req, res) => {
  const result = await lookupService.lookupBookings(req.body.email, req.body.otp_code);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(result) });
});

/**
 * `GET /public/events/bookings/lookup/invoice/:invoiceId/pdf` — a guest's own copy.
 *
 * No session: the `lookup_token` from the request above stands in for one, and
 * `verifyBookingLookupToken` re-derives the email from it rather than trusting
 * anything in the path. `isAdmin: false` matters here — the guest is authorised
 * by `guestEmail` alone, through the guard `getInvoicePdf` applies.
 */
export const downloadLookupInvoicePdf = handler(async (req, res) => {
  await lookupService.assertLookupEnabled();

  const email = verifyBookingLookupToken(bearerToken(req.get('authorization')) ?? '');

  const file = await memberService.getInvoicePdf(BigInt(req.params.invoiceId as string), {
    memberId: null,
    isAdmin: false,
    guestEmail: email,
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename.replace(/["\r\n]/g, '')}"`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  file.stream.pipe(res);
});
