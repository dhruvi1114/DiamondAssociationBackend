import { z } from 'zod';

/** 0 = NEW, 1 = HANDLED. Two states: a to-do list, not a helpdesk. */
export const ENQUIRY_STATUS = { NEW: 0, HANDLED: 1 } as const;

export type EnquiryStatus = (typeof ENQUIRY_STATUS)[keyof typeof ENQUIRY_STATUS];

/**
 * Body of `POST /public/contact`.
 *
 * Deliberately forgiving. Every extra required field on a public form is a
 * person who gives up instead of writing — so only the three things a reply
 * genuinely needs are mandatory: who, where to reply, and what about.
 */
export const submitEnquirySchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().max(20).optional(),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(10).max(4000),
  /**
   * The honeypot. Hidden from people by CSS and never filled by them; bots fill
   * every field they can find. Named to look worth filling, and accepted rather
   * than rejected when it has a value — see the service.
   */
  website: z.string().max(200).optional(),
});

export type SubmitEnquiryInput = z.infer<typeof submitEnquirySchema>;

/** Query for `GET /admin/contact-enquiries`. */
export const listEnquiriesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.coerce
    .number()
    .int()
    .refine((v) => v === ENQUIRY_STATUS.NEW || v === ENQUIRY_STATUS.HANDLED, 'Unknown status')
    .optional(),
  /** Matches the sender's name, email or subject. */
  search: z.string().trim().min(1).max(100).optional(),
});

export type ListEnquiriesQuery = z.infer<typeof listEnquiriesSchema>;
