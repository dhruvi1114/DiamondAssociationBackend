import { z } from 'zod';
import { FOOD_PREFERENCE, GOV_ID_TYPE } from '@modules/event/registration.constants';

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
