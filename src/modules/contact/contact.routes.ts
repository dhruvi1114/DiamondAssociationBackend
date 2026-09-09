import { Router } from 'express';
import { z } from 'zod';

import { authenticateAdmin, authorize, rateLimiters, validateRequest } from '@middleware';
import * as controller from '@modules/contact/contact.controller';
import { listEnquiriesSchema, submitEnquirySchema } from '@modules/contact/contact.types';
import { idParamSchema } from '@modules/member/member.types';

/**
 * `/api/v1/public/contact` — the form anybody can use.
 *
 * Rate limited with the same bucket the OTP endpoints use. A public write
 * endpoint with no limiter is an open relay into the association's inbox, and
 * the honeypot in the service only stops bots that fill every field.
 */
export const contactPublicRouter = Router();

contactPublicRouter.post(
  '/contact',
  rateLimiters.otp,
  validateRequest({ body: submitEnquirySchema }),
  controller.submitEnquiry,
);

/** `/api/v1/admin/contact-enquiries` — the queue behind the form. */
export const contactAdminRouter = Router();

contactAdminRouter.use(authenticateAdmin);

contactAdminRouter.get(
  '/contact-enquiries',
  authorize('enquiry.view'),
  validateRequest({ query: listEnquiriesSchema }),
  controller.listEnquiries,
);

contactAdminRouter.patch(
  '/contact-enquiries/:id/status',
  authorize('enquiry.manage'),
  validateRequest({ params: idParamSchema, body: z.object({ handled: z.boolean() }) }),
  controller.setEnquiryStatus,
);
