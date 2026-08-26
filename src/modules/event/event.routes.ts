import { Router } from 'express';
import { END_POINTS } from '@constant';
import { authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/event/event.controller';
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
  authorize('event.publish'),
  validateRequest({ params: idParamSchema }),
  controller.publishEvent,
);

eventAdminRouter.post(
  `${END_POINTS.EVENTS}/:id/cancel`,
  authorize('event.publish'),
  validateRequest({ params: idParamSchema, body: cancelEventSchema }),
  controller.cancelEvent,
);
