import { z } from 'zod';
import {
  FOOD_PREFERENCE,
  GOV_ID_TYPE,
  SUBMISSION_METHOD,
} from '@modules/event/registration.constants';

/**
 * One delegate on a booking.
 *
 * `member_user_id` names someone already on the company's team, which is how the
 * picker works; the free-text fields are the snapshot taken at booking, so a
 * later profile edit cannot rewrite an old attendee list.
 */
const attendeeSchema = z.object({
  member_user_id: z.string().regex(/^\d+$/).optional(),
  full_name: z.string().trim().min(2).max(150),
  designation: z.string().trim().max(100).optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
  food_preference: z
    .union([
      z.literal(FOOD_PREFERENCE.VEG),
      z.literal(FOOD_PREFERENCE.NON_VEG),
      z.literal(FOOD_PREFERENCE.JAIN),
    ])
    .optional(),
  id_type: z
    .union([
      z.literal(GOV_ID_TYPE.AADHAAR),
      z.literal(GOV_ID_TYPE.PAN),
      z.literal(GOV_ID_TYPE.PASSPORT),
      z.literal(GOV_ID_TYPE.DL),
      z.literal(GOV_ID_TYPE.VOTER),
    ])
    .optional(),
  id_number: z.string().trim().max(50).optional(),
  special_requirement: z.string().trim().max(500).optional(),
});

export type AttendeeInput = z.infer<typeof attendeeSchema>;

/** Body of `POST /events/:slug/register` — a member booking for its team. */
export const registerAsMemberSchema = z.object({
  // At least one, because a booking with nobody on it holds seats for nobody.
  // Capped so a typo cannot take a whole hall in one request.
  attendees: z.array(attendeeSchema).min(1).max(50),
  // Not a default: the association has to be able to prove the payer actually
  // ticked it, and a value the server supplies proves nothing.
  terms_accepted: z.literal(true),
  media_consent: z.boolean().default(false),
  // Billing overrides. The profile supplies these; the form may correct the
  // address for this booking without touching the company record.
  billing_line1: z.string().trim().max(200).optional(),
  billing_line2: z.string().trim().max(200).optional(),
  billing_city: z.string().trim().max(100).optional(),
  billing_state: z.string().trim().max(100).optional(),
  billing_pincode: z.string().trim().max(10).optional(),
  contact_name: z.string().trim().max(150).optional(),
  contact_email: z.string().trim().toLowerCase().email().max(200).optional(),
  contact_phone: z.string().trim().max(20).optional(),
});

export type RegisterAsMemberInput = z.infer<typeof registerAsMemberSchema>;

/** Body of `POST /admin/event-registrations/:id/reject`. */
export const rejectRegistrationSchema = z.object({
  // Mandatory: this is what the applicant is told, and a refusal with no reason
  // is a phone call to the office.
  reason: z.string().trim().min(3).max(500),
});

export type RejectRegistrationInput = z.infer<typeof rejectRegistrationSchema>;

/** Query for the admin booking list. */
export const listRegistrationsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  event_id: z.string().regex(/^\d+$/).optional(),
  /** Comma-separated status codes; empty means every status. */
  status: z
    .string()
    .regex(/^\d+(,\d+)*$/)
    .optional(),
});

export type ListRegistrationsQuery = z.infer<typeof listRegistrationsSchema>;

/** Body of `POST /events/registrations/:id/payment` — "I have paid". */
export const submitPaymentSchema = z.object({
  // Cash is not claimable: money handed over the counter is recorded by the
  // person who took it, not asserted by the payer.
  method: z.union([
    z.literal(SUBMISSION_METHOD.NEFT),
    z.literal(SUBMISSION_METHOD.UPI),
    z.literal(SUBMISSION_METHOD.CHEQUE),
  ]),
  reference_no: z.string().trim().min(3).max(100),
  amount: z.coerce.number().positive(),
  paid_on: z.coerce.date(),
  proof_path: z.string().trim().max(500).optional(),
});

export type SubmitPaymentInput = z.infer<typeof submitPaymentSchema>;

/** Body of `POST /admin/payment-submissions/:id/reject`. */
export const rejectPaymentSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type RejectPaymentInput = z.infer<typeof rejectPaymentSchema>;

/**
 * Body of `POST /public/events/:slug/register` — a non-member booking a seat.
 *
 * Everything is typed by the guest, because the platform holds nothing about
 * them to pre-fill. The address and GST fields are here because they go on the
 * invoice, not because the event needs them.
 */
export const registerAsGuestSchema = z.object({
  full_name: z.string().trim().min(2).max(150),
  designation: z.string().trim().max(100).optional(),
  company_name: z.string().trim().max(200).optional(),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: z.string().trim().min(6).max(20),
  gst_number: z.string().trim().max(20).optional(),
  pan_number: z.string().trim().max(10).optional(),
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  pincode: z.string().trim().max(10).optional(),
  country: z.string().trim().max(100).default('India'),
  food_preference: z
    .union([
      z.literal(FOOD_PREFERENCE.VEG),
      z.literal(FOOD_PREFERENCE.NON_VEG),
      z.literal(FOOD_PREFERENCE.JAIN),
    ])
    .optional(),
  special_requirement: z.string().trim().max(500).optional(),
  terms_accepted: z.literal(true),
  media_consent: z.boolean().default(false),
});

export type RegisterAsGuestInput = z.infer<typeof registerAsGuestSchema>;
