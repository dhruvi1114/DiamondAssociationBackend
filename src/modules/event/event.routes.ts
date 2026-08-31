import { Router } from 'express';
import multer from 'multer';
import { END_POINTS } from '@constant';
import { authenticate, authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/event/event.controller';
import { BANNER_MAX_BYTES } from '@modules/event/event.media.service';
import {
  listRegistrationsSchema,
  registerAsGuestSchema,
  registerAsMemberSchema,
  rejectPaymentSchema,
  rejectRegistrationSchema,
  submitPaymentSchema,
} from '@modules/event/registration.types';
import {
  browseEventsSchema,
  cancelEventSchema,
  createEventSchema,
  listEventsSchema,
  updateEventSchema,
} from '@modules/event/event.types';
import { idParamSchema } from '@modules/member/member.types';

/**
 * In memory, like every other upload here: the bytes are sniffed before anything
 * touches the filesystem. This limit only stops a large body being buffered at
 * all; the media service applies the same ceiling again against the real size.
 */
const uploadBanner = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BANNER_MAX_BYTES, files: 1 },
});

/** `/api/v1/admin/events` — staff-facing event management (A-21…A-22). */
export const eventAdminRouter = Router();

eventAdminRouter.use(authenticateAdmin);

eventAdminRouter.get(
  END_POINTS.EVENTS,
  authorize('event.view'),
  validateRequest({ query: listEventsSchema }),
  controller.listEvents,
);

eventAdminRouter.post(
  END_POINTS.EVENTS,
  authorize('event.manage'),
  validateRequest({ body: createEventSchema }),
  controller.createEvent,
);

eventAdminRouter.get(
  `${END_POINTS.EVENTS}/:id`,
  authorize('event.view'),
  validateRequest({ params: idParamSchema }),
  controller.getEvent,
);

eventAdminRouter.patch(
  `${END_POINTS.EVENTS}/:id`,
  authorize('event.manage'),
  validateRequest({ params: idParamSchema, body: updateEventSchema }),
  controller.updateEvent,
);

/*
  The poster. Its own upload rather than a field on the event form: the stored
  value is a key the server decides, so there is nothing for the form to hold in
  its draft — the upload IS the save.
*/
eventAdminRouter.get(
  `${END_POINTS.EVENTS}/:id/banner`,
  authorize('event.view'),
  validateRequest({ params: idParamSchema }),
  controller.serveAdminBanner,
);

eventAdminRouter.post(
  `${END_POINTS.EVENTS}/:id/banner`,
  authorize('event.manage'),
  validateRequest({ params: idParamSchema }),
  uploadBanner.single('file'),
  controller.uploadBanner,
);

eventAdminRouter.delete(
  `${END_POINTS.EVENTS}/:id/banner`,
  authorize('event.manage'),
  validateRequest({ params: idParamSchema }),
  controller.removeBanner,
);

eventAdminRouter.post(
  `${END_POINTS.EVENTS}/:id/publish`,
  authorize('event.manage'),
  validateRequest({ params: idParamSchema }),
  controller.publishEvent,
);

eventAdminRouter.post(
  `${END_POINTS.EVENTS}/:id/cancel`,
  authorize('event.manage'),
  validateRequest({ params: idParamSchema, body: cancelEventSchema }),
  controller.cancelEvent,
);

eventAdminRouter.delete(
  `${END_POINTS.EVENTS}/:id`,
  authorize('event.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteEvent,
);

eventAdminRouter.get(
  `${END_POINTS.EVENTS}/:id/attendees/export`,
  authorize('event.view'),
  validateRequest({ params: idParamSchema }),
  controller.exportAttendees,
);

eventAdminRouter.get(
  `${END_POINTS.EVENTS}/:id/attendees/export`,
  authorize('event.view'),
  validateRequest({ params: idParamSchema }),
  controller.exportAttendees,
);

eventAdminRouter.get(
  `${END_POINTS.EVENTS}/:id/attendees`,
  authorize('event.view'),
  validateRequest({ params: idParamSchema }),
  controller.listAttendees,
);

eventAdminRouter.get(
  '/event-registrations',
  authorize('event.view'),
  validateRequest({ query: listRegistrationsSchema }),
  controller.listRegistrations,
);

eventAdminRouter.get(
  '/event-registrations/:id',
  authorize('event.view'),
  validateRequest({ params: idParamSchema }),
  controller.getRegistration,
);

eventAdminRouter.post(
  '/event-registrations/:id/approve',
  authorize('event.manage'),
  validateRequest({ params: idParamSchema }),
  controller.approveRegistration,
);

eventAdminRouter.post(
  '/event-registrations/:id/reject',
  authorize('event.manage'),
  validateRequest({ params: idParamSchema, body: rejectRegistrationSchema }),
  controller.rejectRegistration,
);

eventAdminRouter.get(
  '/payment-submissions',
  authorize('payment.view'),
  validateRequest({ query: listRegistrationsSchema }),
  controller.listPaymentSubmissions,
);

eventAdminRouter.post(
  '/payment-submissions/:id/verify',
  authorize('payment.record'),
  validateRequest({ params: idParamSchema }),
  controller.verifyPayment,
);

eventAdminRouter.post(
  '/payment-submissions/:id/reject',
  authorize('payment.record'),
  validateRequest({ params: idParamSchema, body: rejectPaymentSchema }),
  controller.rejectPayment,
);

/** `/api/v1/public/events` — the public site. No session. */
export const eventPublicRouter = Router();

/*
  Route order matters: `/events/filters` is declared before `/events/:slug`, or
  the slug pattern swallows it.
*/
eventPublicRouter.get(`${END_POINTS.EVENTS}/filters`, controller.eventFacets);
eventPublicRouter.get(
  END_POINTS.EVENTS,
  validateRequest({ query: browseEventsSchema }),
  controller.listPublicEvents,
);
eventPublicRouter.get(`${END_POINTS.EVENTS}/:slug`, controller.getPublicEvent);
eventPublicRouter.get(`${END_POINTS.EVENTS}/:slug/banner`, controller.serveBanner);

eventPublicRouter.post(
  `${END_POINTS.EVENTS}/:slug/register`,
  validateRequest({ body: registerAsGuestSchema }),
  controller.registerAsGuest,
);

// The token IS the credential, so these carry no session and no id in the path.
eventPublicRouter.get(`${END_POINTS.EVENTS}/booking/:token`, controller.getGuestBooking);

eventPublicRouter.post(
  `${END_POINTS.EVENTS}/booking/:token/payment`,
  validateRequest({ body: submitPaymentSchema }),
  controller.submitGuestPayment,
);

/**
 * `/api/v1/events` — the member's event list (C-24).
 *
 * Mounted ON `/events`, and its paths are relative to that — NOT mounted on
 * `/api/v1` with `/events` repeated in every route.
 *
 * The distinction is the whole reason this comment exists. `router.use(path)`
 * only checks that the request starts with `path`, so mounting this at
 * `/api/v1` ran its `use(authenticate)` — a member-audience check — against
 * every single request in the API. Everything registered after it in
 * `routes/index.ts` was then answered by the member guard before it could reach
 * its own router: an admin's token was rejected as the wrong audience on
 * `/admin/applications`, and the login-free correction links under `/public`
 * started demanding a session they are defined never to have.
 *
 * Keep the mount narrow. A path-less `use()` inside a router mounted at the top
 * of a namespace is a guard on the whole namespace.
 */
export const eventMemberRouter = Router();

eventMemberRouter.use(authenticate);

eventMemberRouter.get('/filters', controller.eventFacets);
eventMemberRouter.get(
  '/',
  validateRequest({ query: browseEventsSchema }),
  controller.listMemberEvents,
);
// Declared before `/:slug`, or "registrations" is read as an event slug.
eventMemberRouter.get('/registrations/mine', controller.listMyBookings);

eventMemberRouter.get('/:slug', controller.getMemberEvent);
eventMemberRouter.get('/:slug/banner', controller.serveBanner);

eventMemberRouter.post(
  '/:slug/register',
  validateRequest({ body: registerAsMemberSchema }),
  controller.registerForEvent,
);

eventMemberRouter.post(
  '/registrations/:id/cancel',
  validateRequest({ params: idParamSchema }),
  controller.cancelOwnBooking,
);

eventMemberRouter.post(
  '/registrations/:id/payment',
  validateRequest({ params: idParamSchema, body: submitPaymentSchema }),
  controller.submitPayment,
);
