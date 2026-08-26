import { Router } from 'express';
import { END_POINTS } from '@constant';
import { authenticate, authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/event/event.controller';
import {
  listRegistrationsSchema,
  registerAsGuestSchema,
  registerAsMemberSchema,
  rejectPaymentSchema,
  rejectRegistrationSchema,
  submitPaymentSchema,
} from '@modules/event/registration.types';
import {
  cancelEventSchema,
  createEventSchema,
  listEventsSchema,
  updateEventSchema,
} from '@modules/event/event.types';
import { idParamSchema } from '@modules/member/member.types';

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

eventPublicRouter.get(END_POINTS.EVENTS, controller.listPublicEvents);
eventPublicRouter.get(`${END_POINTS.EVENTS}/:slug`, controller.getPublicEvent);

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

/** `/api/v1/events` — the member's event list (C-24). */
export const eventMemberRouter = Router();

eventMemberRouter.use(authenticate);

eventMemberRouter.get(END_POINTS.EVENTS, controller.listMemberEvents);
eventMemberRouter.get(`${END_POINTS.EVENTS}/:slug`, controller.getMemberEvent);

eventMemberRouter.post(
  `${END_POINTS.EVENTS}/:slug/register`,
  validateRequest({ body: registerAsMemberSchema }),
  controller.registerForEvent,
);

eventMemberRouter.post(
  `${END_POINTS.EVENTS}/registrations/:id/payment`,
  validateRequest({ params: idParamSchema, body: submitPaymentSchema }),
  controller.submitPayment,
);
