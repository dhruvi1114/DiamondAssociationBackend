import { z } from 'zod';
import { EVENT_VISIBILITY } from '@modules/event/event.constants';

/**
 * A day, not an instant.
 *
 * Price tier boundaries are DATE columns and are compared by day, so anything
 * with a time on it would only invite confusion about whether 15 Nov 23:00 is
 * still inside a tier ending on the 15th. It is — see `event.pricing.ts`.
 */
const dateOnly = z.coerce.date();

const priceTierSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    starts_on: dateOnly,
    ends_on: dateOnly,
    member_price: z.coerce.number().min(0),
    non_member_price: z.coerce.number().min(0),
    display_order: z.coerce.number().int().min(0).default(0),
  })
  .refine((tier) => tier.ends_on >= tier.starts_on, {
    message: 'validation.tierEndsBeforeItStarts',
    path: ['ends_on'],
  });

/**
 * Do any two windows share a day?
 *
 * The exclusion constraint in the database is the real guarantee, but it surfaces
 * as a raw Postgres error the admin screen cannot attach to a field. Checking
 * here turns it into a message against `price_tiers`; the constraint stays as the
 * thing that genuinely cannot be bypassed.
 */
const hasOverlap = (tiers: { starts_on: Date; ends_on: Date }[]): boolean =>
  tiers.some((a, i) =>
    tiers.some((b, j) => i !== j && a.starts_on <= b.ends_on && b.starts_on <= a.ends_on),
  );

const eventShape = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(20_000).optional(),
  start_at: z.coerce.date(),
  end_at: z.coerce.date(),
  venue_name: z.string().trim().max(200).optional(),
  venue_address_line1: z.string().trim().max(200).optional(),
  venue_address_line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  pincode: z.string().trim().max(10).optional(),
  country: z.string().trim().max(100).default('India'),
  map_url: z.string().trim().url().max(2000).optional(),
  visibility: z
    .union([z.literal(EVENT_VISIBILITY.MEMBER_ONLY), z.literal(EVENT_VISIBILITY.PUBLIC)])
    .default(EVENT_VISIBILITY.MEMBER_ONLY),
  tax_rate: z.coerce.number().min(0).max(100).default(0),
  capacity: z.coerce.number().int().positive().nullable().default(null),
  registration_opens_at: z.coerce.date().nullable().default(null),
  registration_closes_at: z.coerce.date().nullable().default(null),
  requires_approval: z.boolean().default(false),
  collect_food_preference: z.boolean().default(true),
  collect_photo: z.boolean().default(false),
  collect_gov_id: z.boolean().default(false),
  // At least one, always. A free event is one tier priced at zero — an event with
  // no tier has no answer to "what does this cost?", and publishing it would put
  // a Register button on a page that cannot name a price.
  price_tiers: z.array(priceTierSchema).min(1).max(12),
});

export const createEventSchema = eventShape
  .refine((event) => event.end_at > event.start_at, {
    message: 'validation.eventEndsBeforeItStarts',
    path: ['end_at'],
  })
  .refine(
    (event) => !event.registration_closes_at || event.registration_closes_at <= event.start_at,
    { message: 'validation.registrationClosesAfterStart', path: ['registration_closes_at'] },
  )
  .refine(
    (event) =>
      !event.registration_opens_at ||
      !event.registration_closes_at ||
      event.registration_closes_at >= event.registration_opens_at,
    { message: 'validation.registrationWindowInverted', path: ['registration_closes_at'] },
  )
  .refine((event) => !hasOverlap(event.price_tiers), {
    message: 'validation.priceTiersOverlap',
    path: ['price_tiers'],
  });

export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = createEventSchema;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

/** Query for the admin event list. */
export const listEventsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  search: z.string().trim().max(200).optional(),
  status: z.coerce.number().int().min(0).max(3).optional(),
  visibility: z.coerce.number().int().min(0).max(1).optional(),
});

export type ListEventsQuery = z.infer<typeof listEventsSchema>;
