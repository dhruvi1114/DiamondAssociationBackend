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

/** Midnight at the top of the day this instant falls in, in the server's zone. */
const startOfDay = (value: Date): Date =>
  new Date(value.getFullYear(), value.getMonth(), value.getDate());

const eventShape = z.object({
  title: z.string().trim().min(3).max(200),
  /*
    From the `EventTypes` master, and optional. Nullable rather than required
    because the master is the association's to curate: an empty list on day one
    must not block event creation, and the events that existed before the field
    did have no honest value to give it.

    A string on the wire — every id in this API is, since a bigint does not
    survive JSON intact — and coerced here.
  */
  event_type_id: z
    .string()
    .trim()
    .regex(/^\d+$/, 'validation.invalidId')
    .nullable()
    .optional()
    .default(null),
  description: z.string().trim().max(20_000).optional(),
  /* The poster itself uploads separately; only its description is form data. */
  banner_alt: z.string().trim().max(200).nullable().optional().default(null),
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
  /*
    A stated deadline has to leave a clear day before the event (client decision,
    2026-08-27). `<= start_at` used to be enough, which let the deadline land on
    the morning of the event itself — and a booking taken then arrives after the
    badges are printed and the caterer's count has gone in, which is the whole
    reason a deadline exists.

    Compared against the START OF the start day, not the start instant: an event
    beginning at 09:00 must not accept a deadline of 08:00 the same morning.

    Left blank the field still means "open until the event begins". That is not
    a deadline at all — it is the absence of one — and an association that wants
    to take bookings to the last minute is entitled to say so.
  */
  .refine(
    (event) =>
      !event.registration_closes_at || event.registration_closes_at < startOfDay(event.start_at),
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

/**
 * Body of `POST /admin/events/:id/cancel`.
 *
 * The reason is mandatory: it is what everyone registered is told, and a
 * cancellation with no explanation is the version that generates support calls.
 */
export const cancelEventSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type CancelEventInput = z.infer<typeof cancelEventSchema>;

/**
 * A comma-separated list on the wire.
 *
 * `?type=1,2` rather than repeated keys: it is what a person can read in an
 * address bar and share, and it is the shape the other filtered lists in this
 * API already use.
 */
const csv = z
  .string()
  .trim()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

/** Query for the public and member events listing. */
export const browseEventsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(60).default(24),
  /** `EventTypes` ids. */
  type: csv.pipe(z.array(z.string().regex(/^\d+$/, 'validation.invalidId'))).optional(),
  city: csv.optional(),
  state: csv.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  price: z.enum(['free', 'paid']).optional(),
  /*
    "Only what I can still book." A separate flag rather than a price value,
    because it answers a different question — one is what it costs, the other is
    whether the door is still open.
  */
  open: z.coerce.boolean().optional(),
  /*
    Two orders over the same column. "Upcoming" is what a browsing page wants —
    the next thing to book first — and "recent" is the archive read, newest past
    event first. Both are `start_at`; nothing here sorts by relevance, which
    would be a third thing to define and defend on a list of a dozen events.
  */
  sort: z.enum(['upcoming', 'recent']).default('upcoming'),
});

export type BrowseEventsQuery = z.infer<typeof browseEventsSchema>;
