import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { bannerUrl } from '@modules/event/event.media';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { EVENT_STATUS } from '@modules/event/event.constants';
import { getNumericSetting, SETTING_KEYS } from '@helpers/settings';
import {
  audienceFor,
  effectiveMembershipValidTill,
  resolveTier,
} from '@modules/event/event.pricing';
import { DEFAULT_GRACE_DAYS, SEAT_HOLDING_STATUSES } from '@modules/event/registration.constants';
import * as repo from '@modules/event/event.repository';
import { cancelEventWithRefunds } from '@modules/event/registration.service';
import { touchedByAdmin } from '@modules/event/actorColumns';
import { AppError } from '@utils/appError';
import type {
  CreateEventInput,
  ListEventsQuery,
  UpdateEventInput,
} from '@modules/event/event.types';
import type { Db } from '@db/prisma';
import type { PriceTier } from '@modules/event/event.pricing';

/** Who performed the action, for audit attribution. */
export interface EventActor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const notFound = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.notFound' });

const conflict = (messageKey: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey });

/**
 * A URL-safe slug for the title, with a short random suffix.
 *
 * The suffix is not decoration: two events called "Annual General Meeting" are
 * completely normal, and without it the second one would fail to save on a unique
 * violation the admin can do nothing about.
 */
const slugify = (title: string): string => {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);

  return `${base || 'event'}-${randomBytes(3).toString('hex')}`;
};

const tierRows = (
  eventId: bigint,
  input: CreateEventInput,
  adminId: bigint,
): Prisma.EventPriceTierUncheckedCreateInput[] =>
  input.price_tiers.map((tier, index) => ({
    event_id: eventId,
    name: tier.name,
    starts_on: tier.starts_on,
    ends_on: tier.ends_on,
    member_price: new Prisma.Decimal(tier.member_price),
    non_member_price: new Prisma.Decimal(tier.non_member_price),
    display_order: tier.display_order || index,
    created_by_admin_id: adminId,
  }));

const eventColumns = (input: CreateEventInput) => ({
  title: input.title,
  /*
    Not validated against the master here on purpose. The foreign key already
    refuses an id that is not a live type, and it does so inside the same
    transaction as the write — a lookup first would be a second round trip that
    can still lose the race with a delete happening beside it.
  */
  event_type_id: input.event_type_id ? BigInt(input.event_type_id) : null,
  description: input.description ?? null,
  banner_alt: input.banner_alt ?? null,
  start_at: input.start_at,
  end_at: input.end_at,
  venue_name: input.venue_name ?? null,
  venue_address_line1: input.venue_address_line1 ?? null,
  venue_address_line2: input.venue_address_line2 ?? null,
  city: input.city ?? null,
  state: input.state ?? null,
  pincode: input.pincode ?? null,
  country: input.country,
  map_url: input.map_url ?? null,
  visibility: input.visibility,
  tax_rate: new Prisma.Decimal(input.tax_rate),
  capacity: input.capacity,
  registration_opens_at: input.registration_opens_at,
  registration_closes_at: input.registration_closes_at,
  requires_approval: input.requires_approval,
  collect_food_preference: input.collect_food_preference,
  collect_photo: input.collect_photo,
  collect_gov_id: input.collect_gov_id,
});

/** Write the tier set for an event, replacing whatever was there. */
const replaceTiers = async (
  tx: Db,
  eventId: bigint,
  input: CreateEventInput,
  adminId: bigint,
): Promise<void> => {
  await repo.deleteTiersForEvent(tx, eventId);
  await repo.createTiers(tx, tierRows(eventId, input, adminId));
};

/** Create a draft event with its price table. Nobody can see it until it is published. */
export const createEvent = async (input: CreateEventInput, actor: EventActor) => {
  const created = await prisma.$transaction(async (tx) => {
    const event = await repo.createEvent(tx, {
      ...eventColumns(input),
      slug: slugify(input.title),
      status: EVENT_STATUS.DRAFT,
      created_by_admin_id: actor.id,
    });

    await replaceTiers(tx, event.id, input, actor.id);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_CREATED,
      entityName: 'Events',
      entityId: event.id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      after: { title: event.title, visibility: event.visibility, status: event.status },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return event;
  });

  return repo.findEventById(prisma, created.id);
};

/**
 * Edit an event and re-price it.
 *
 * A cancelled event is frozen: it has already been announced as called off, and
 * editing it would change what attendees were told after the fact. Editing a
 * published event is allowed — dates and venues genuinely change — and Task 5's
 * notification work is what tells the people already registered.
 */
export const updateEvent = async (id: bigint, input: UpdateEventInput, actor: EventActor) => {
  const existing = await repo.findEventById(prisma, id);

  if (!existing) throw notFound();

  if (existing.status === EVENT_STATUS.CANCELLED) {
    throw conflict('event.cancelledCannotEdit');
  }

  await prisma.$transaction(async (tx) => {
    await repo.updateEvent(tx, id, {
      ...eventColumns(input),
      ...touchedByAdmin(actor.id),
    });

    await replaceTiers(tx, id, input, actor.id);

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_UPDATED,
      entityName: 'Events',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { title: existing.title, visibility: existing.visibility },
      after: { title: input.title, visibility: input.visibility },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });
  });

  return repo.findEventById(prisma, id);
};

/** One event with its price table, for the admin detail screen. */
/**
 * One event, for the admin screens.
 *
 * `banner_path` is swapped for `banner_url` on the way out. Two reasons, and
 * both were live bugs: the edit drawer decides whether to load the poster by
 * looking for `banner_url`, so the raw row meant an event with a poster opened
 * showing an empty Upload box — and the path itself is a storage key, which
 * `api-conventions.md` §8 keeps out of responses the same way the member
 * module drops `file_path`.
 */
export const getEvent = async (id: bigint) => {
  const event = await repo.findEventById(prisma, id);

  if (!event) throw notFound();

  const { banner_path, ...rest } = event;

  return { ...rest, banner_url: bannerUrl(event.slug, banner_path) };
};

/** The admin list, paged. */
export const listEvents = async (query: ListEventsQuery) => {
  const rows = await repo.listEventsAdmin(query);

  return {
    rows: rows.map(({ total: _total, ...row }) => row),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
};

/**
 * Make an event visible to its audience.
 *
 * Refused without a price tier: publishing would put a Register button on a page
 * that cannot name a price. Refused when already published, so a second click
 * cannot re-announce an event to everyone.
 *
 * The audience size travels back with the result because the confirmation dialog
 * quotes it before the click — keeping it means the audit row records what the
 * admin was actually told, not what the number happens to be later.
 */
export const publishEvent = async (id: bigint, actor: EventActor) => {
  const event = await repo.findEventById(prisma, id);

  if (!event) throw notFound();

  if (event.status === EVENT_STATUS.CANCELLED) throw conflict('event.cancelledCannotEdit');
  if (event.status !== EVENT_STATUS.DRAFT) throw conflict('event.alreadyPublished');
  if (event.price_tiers.length === 0) throw conflict('event.noPriceTier');

  const audienceSize = await repo.countPublishAudience(prisma);

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateEvent(tx, id, {
      status: EVENT_STATUS.PUBLISHED,
      ...touchedByAdmin(actor.id),
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_PUBLISHED,
      entityName: 'Events',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { status: event.status },
      after: { status: EVENT_STATUS.PUBLISHED, audience_size: audienceSize },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { id: updated.id.toString(), status: updated.status, audience_size: audienceSize };
  });
};

/**
 * Call an event off.
 *
 * While seats are held this is refused rather than allowed-with-a-warning: every
 * held seat is either money already taken or a person expecting to attend, and
 * cancelling without deciding what happens to them is exactly the state that
 * produces refund disputes. The registration work replaces this guard with the
 * refund-all flow; until then, refusing is the honest answer.
 */
export const cancelEvent = async (id: bigint, input: { reason: string }, actor: EventActor) => {
  const event = await repo.findEventById(prisma, id);

  if (!event) throw notFound();
  if (event.status === EVENT_STATUS.CANCELLED) throw conflict('event.cancelledCannotEdit');

  /*
    Everyone holding a seat is cancelled and refunded first, then the event is
    marked off. That order matters: if the event were marked cancelled first and
    a refund then failed, the screen would say "called off" while somebody was
    still owed their money and had not been told.

    Deliberately outside the event's own transaction. Each booking commits on its
    own, so one failure leaves the rest correctly refunded rather than rolling
    back the whole night's work — and the count of failures comes back to the
    caller rather than being swallowed.
  */
  const outcome =
    event.seats_taken > 0
      ? await cancelEventWithRefunds(
          id,
          { reason: input.reason },
          {
            adminId: actor.id,
            ip: actor.ip,
            userAgent: actor.userAgent,
            requestId: actor.requestId,
          },
        )
      : { cancelled: 0, refunded: 0, failed: 0 };

  if (outcome.failed > 0) {
    // The event stays live. Half-cancelled is the one state nobody can act on:
    // some attendees told, some not, and no way to tell which from the screen.
    throw conflict('event.cancelPartiallyFailed');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await repo.updateEvent(tx, id, {
      status: EVENT_STATUS.CANCELLED,
      ...touchedByAdmin(actor.id),
    });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_CANCELLED,
      entityName: 'Events',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { status: event.status },
      after: {
        status: EVENT_STATUS.CANCELLED,
        reason: input.reason,
        bookings_cancelled: outcome.cancelled,
        refunds_raised: outcome.refunded,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return {
      id: updated.id.toString(),
      status: updated.status,
      bookings_cancelled: outcome.cancelled,
      refunds_raised: outcome.refunded,
    };
  });
};

/**
 * Remove an event.
 *
 * Soft-delete, and only while nobody holds a seat. Once seats are held the event
 * has an audience: the honest action is to cancel it — which forces a decision
 * about refunds and tells everyone — not to make it disappear from the admin's
 * own list while the people who booked still expect to attend.
 */
export const deleteEvent = async (id: bigint, actor: EventActor) => {
  const event = await repo.findEventById(prisma, id);

  if (!event) throw notFound();
  if (event.seats_taken > 0) throw conflict('event.hasRegistrations');

  return prisma.$transaction(async (tx) => {
    await repo.updateEvent(tx, id, { deletedAt: new Date(), ...touchedByAdmin(actor.id) });

    await writeAudit(tx, {
      action: AUDIT_ACTIONS.EVENT_DELETED,
      entityName: 'Events',
      entityId: id,
      actorType: ACTOR_TYPES.ADMIN,
      actorId: actor.id,
      before: { title: event.title, status: event.status },
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
    });

    return { id: id.toString() };
  });
};

/* --- browsing: public and member ------------------------------------------ */

/** How many seats are still sellable, or null when the event is uncapped. */
const seatsLeft = (capacity: number | null, taken: number): number | null =>
  capacity === null ? null : Math.max(0, capacity - taken);

/**
 * Is the Register button live right now?
 *
 * Four independent reasons it might not be, and the page says which — a disabled
 * button with no reason is the version people phone the office about.
 */
const registrationState = (
  event: {
    registration_opens_at: Date | null;
    registration_closes_at: Date | null;
    capacity: number | null;
    seats_taken: number;
  },
  tier: PriceTier | null,
  now: Date,
) => {
  if (event.registration_opens_at && now < event.registration_opens_at) {
    return { open: false, reason: 'NOT_OPEN_YET' as const };
  }

  if (event.registration_closes_at && now > event.registration_closes_at) {
    return { open: false, reason: 'CLOSED' as const };
  }

  if (seatsLeft(event.capacity, event.seats_taken) === 0) {
    return { open: false, reason: 'SOLD_OUT' as const };
  }

  // No tier covers today, so there is no price. Refusing is the only honest
  // answer; inventing a fallback is how billing disputes start.
  if (!tier) return { open: false, reason: 'NO_PRICE_TODAY' as const };

  return { open: true, reason: null };
};

/** How much of the description a card carries before it stops being a card. */
const EXCERPT_MAX = 180;

/**
 * A card-sized opening of the description.
 *
 * Cut on a word, never mid-word, and only when there is something left to cut:
 * a 182-character description ending in "…" claims there is more to read when
 * there are two characters of it. Whitespace is collapsed first, because the
 * field is a textarea and the newlines an admin typed are not layout a card
 * can honour.
 */
export const excerpt = (text: string | null): string | null => {
  if (!text) return null;

  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= EXCERPT_MAX) return flat;

  const cut = flat.slice(0, EXCERPT_MAX);
  const lastSpace = cut.lastIndexOf(' ');

  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, '')}…`;
};

const browseRow = (row: repo.BrowseEventRow) => ({
  id: row.id.toString(),
  slug: row.slug,
  title: row.title,
  banner_url: bannerUrl(row.slug, row.banner_path),
  banner_alt: row.banner_alt,
  excerpt: excerpt(row.description),
  event_type: row.event_type,
  start_at: row.start_at,
  end_at: row.end_at,
  venue_name: row.venue_name,
  city: row.city,
  visibility: row.visibility,
  seats_left: seatsLeft(row.capacity, row.seats_taken),
  registration_closes_at: row.registration_closes_at,
  tier_name: row.tier_name,
  member_price: row.member_price?.toFixed(2) ?? null,
  non_member_price: row.non_member_price?.toFixed(2) ?? null,
});

const paged = (rows: repo.BrowseEventRow[]) => ({
  rows: rows.map(browseRow),
  total: rows.length > 0 ? Number(rows[0].total) : 0,
});

interface BrowseQuery extends repo.BrowseFilters {
  page: number;
  limit: number;
}

/**
 * Whether a signed-in user is entitled to member benefits right now — member
 * pricing, member-only events, the directory, and so on.
 *
 * An approved member who has not yet paid their membership invoice IS a
 * member (they can log in, see their profile, and pay), but gets none of
 * those benefits until the invoice clears. This asks that question the same
 * way the booking-price path (`registration.service.ts`) and the event-detail
 * path (`getMemberEvent` above) already do: resolve the member's current
 * term, then hand it to `effectiveMembershipValidTill` and `audienceFor` —
 * the two functions that hold this rule. Nothing here re-derives the answer
 * from `member.status` or `term.status` directly; a hand-written second
 * status check is exactly how a member-only event or the wrong list price
 * leaked through before.
 *
 * `undefined` (no session) is NON_MEMBER, same as a member with no active
 * term — both see the guest-facing view.
 */
export const resolveMemberBenefits = async (
  userId: bigint | undefined,
  now = new Date(),
): Promise<boolean> => {
  if (userId === undefined) return false;

  const member = await prisma.member.findFirst({
    where: { team_users: { some: { user_id: userId, status: 1 } }, deletedAt: null },
    select: { current_term: { select: { status: true, valid_till: true } } },
  });

  const graceDays = await getNumericSetting(SETTING_KEYS.MEMBERSHIP_GRACE_DAYS, DEFAULT_GRACE_DAYS);

  const audience = audienceFor({
    membershipValidTill: effectiveMembershipValidTill(member?.current_term),
    graceDays,
    on: now,
  });

  return audience === 'MEMBER';
};

/** Published public events, for a visitor with no session. */
export const listPublicEvents = async ({ page, limit, ...filters }: BrowseQuery) =>
  paged(await repo.listPublicEvents(page, limit, filters));

/**
 * Published events of both kinds, for a signed-in member — but ONLY when that
 * member currently has member benefits. An approved member who has not paid
 * sees exactly the public set, same as a guest: `publicOnly` is driven by
 * `resolveMemberBenefits`, never by "a token was presented."
 */
export const listMemberEvents = async (
  { page, limit, ...filters }: BrowseQuery,
  publicOnly: boolean,
) => paged(await repo.listMemberEvents(page, limit, filters, publicOnly));

/** The filter rail's options, counted against what this audience can see. */
export const browseFacets = (publicOnly: boolean) => repo.browseFacets(publicOnly);

/** The shared detail shape: the whole tier table plus what applies today. */
const eventDetail = (
  event: NonNullable<Awaited<ReturnType<typeof repo.findEventById>>>,
  now: Date,
) => {
  const tier = resolveTier(event.price_tiers as PriceTier[], now);
  const state = registrationState(event, tier, now);

  return {
    id: event.id.toString(),
    slug: event.slug,
    title: event.title,
    /* Both, because the form needs the id to preselect and every reader needs
       the name to display. */
    event_type_id: event.event_type_id?.toString() ?? null,
    event_type: event.event_type?.name ?? null,
    description: event.description,
    /*
      The URL, not the storage key. A key is a private detail of where the file
      lives; the reader needs an address they can put in an `<img src>`.
    */
    banner_url: bannerUrl(event.slug, event.banner_path),
    banner_alt: event.banner_alt,
    start_at: event.start_at,
    end_at: event.end_at,
    venue_name: event.venue_name,
    venue_address_line1: event.venue_address_line1,
    venue_address_line2: event.venue_address_line2,
    city: event.city,
    state: event.state,
    pincode: event.pincode,
    country: event.country,
    map_url: event.map_url,
    visibility: event.visibility,
    capacity: event.capacity,
    /* So the booking screen can show tax before the reader commits, rather than
       letting the invoice be the first place they meet it. */
    tax_rate: event.tax_rate.toFixed(2),
    seats_left: seatsLeft(event.capacity, event.seats_taken),
    registration_opens_at: event.registration_opens_at,
    registration_closes_at: event.registration_closes_at,
    requires_approval: event.requires_approval,
    collects: {
      food_preference: event.collect_food_preference,
      photo: event.collect_photo,
      gov_id: event.collect_gov_id,
    },
    price_tiers: event.price_tiers.map((row) => ({
      name: row.name,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      member_price: row.member_price.toFixed(2),
      non_member_price: row.non_member_price.toFixed(2),
    })),
    // Null, not a fallback price, when no tier covers today.
    current_price: tier
      ? {
          tier_name: tier.name,
          applies_until: tier.ends_on,
          member_price: tier.member_price.toFixed(2),
          non_member_price: tier.non_member_price.toFixed(2),
        }
      : null,
    registration_open: state.open,
    registration_blocked_reason: state.reason,
  };
};

/** One public event by slug, or null when it is not the public's to see. */
export const getPublicEvent = async (slug: string, now = new Date()) => {
  const event = await repo.findPublicEventBySlug(prisma, slug);

  return event ? eventDetail(event, now) : null;
};

/**
 * This company's live booking on this event, if it has one.
 *
 * "Live" is statuses 0–3, the same set the `EventRegistrations_one_live_per_member`
 * partial unique index is built on — so this returns a booking exactly when a
 * second one would be refused. A company whose hold expired or who cancelled
 * gets null and may book again, which is what that index is partial for.
 *
 * Without this the detail page has no idea the reader has already booked: it
 * offers "Register Now", takes them through the whole form, and answers with a
 * conflict at the point of submission.
 */
const liveBookingFor = async (memberId: bigint, eventId: bigint) => {
  const booking = await prisma.eventRegistration.findFirst({
    where: {
      member_id: memberId,
      event_id: eventId,
      status: { in: SEAT_HOLDING_STATUSES },
      deletedAt: null,
    },
    include: {
      invoice: { select: { id: true, invoice_number: true, status: true } },
      attendees: {
        orderBy: { id: 'asc' },
        select: {
          attendee_code: true,
          full_name: true,
          designation: true,
          /* Both optional on the model, so both nullable here — a colleague
             added by name alone has neither, and the table says so rather than
             leaving the cell blank. */
          email: true,
          phone: true,
          unit_price: true,
        },
      },
    },
  });

  if (!booking) return null;

  return {
    id: booking.id.toString(),
    registration_code: booking.registration_code,
    status: booking.status,
    seats: booking.attendee_count,
    total_amount: booking.total_amount.toFixed(2),
    expires_at: booking.expires_at,
    invoice: booking.invoice
      ? {
          id: booking.invoice.id.toString(),
          invoice_number: booking.invoice.invoice_number,
          status: booking.invoice.status,
        }
      : null,
    attendees: booking.attendees.map((person) => ({
      attendee_code: person.attendee_code,
      full_name: person.full_name,
      designation: person.designation,
      email: person.email,
      phone: person.phone,
      unit_price: person.unit_price.toFixed(2),
    })),
  };
};

/**
 * One published event by slug for a signed-in member, either visibility.
 *
 * Carries `your_price` — what *this* viewer would actually be charged — beside
 * the two published prices. Without it the page advertises "Members ₹1,000" to
 * a signed-in applicant whose membership is not active, who is then billed
 * ₹2,000 at the point of booking. The rule is right; showing them the other
 * number is what was wrong.
 */
export const getMemberEvent = async (slug: string, userId?: bigint, now = new Date()) => {
  const event = await repo.findMemberEventBySlug(prisma, slug);

  if (!event) return null;

  const detail = eventDetail(event, now);

  /* `your_booking` is on every branch, null included. A field that appears only
     sometimes is a field the client has to guard for, and the one branch that
     forgot it would be the one that silently offered a second booking. */
  if (!userId) {
    return { ...detail, your_price: null, your_audience: null, your_booking: null };
  }

  const member = await prisma.member.findFirst({
    where: { team_users: { some: { user_id: userId, status: 1 } }, deletedAt: null },
    select: { id: true, current_term: { select: { status: true, valid_till: true } } },
  });

  /* Looked up before the pricing branch below: a booking exists whether or not
     a price tier covers today, and returning null here on a lapsed tier would
     put "Register Now" back in front of somebody who has already paid. */
  const yourBooking = member ? await liveBookingFor(member.id, event.id) : null;

  if (!detail.current_price) {
    return { ...detail, your_price: null, your_audience: null, your_booking: yourBooking };
  }

  const graceDays = await getNumericSetting(SETTING_KEYS.MEMBERSHIP_GRACE_DAYS, DEFAULT_GRACE_DAYS);

  const audience = audienceFor({
    membershipValidTill: effectiveMembershipValidTill(member?.current_term),
    graceDays,
    on: now,
  });

  return {
    ...detail,
    your_booking: yourBooking,
    your_audience: audience,
    your_price:
      audience === 'MEMBER'
        ? detail.current_price.member_price
        : detail.current_price.non_member_price,
    /* When it expired, so the page can say how long is left to renew. */
    membership_valid_till: member?.current_term?.valid_till ?? null,
    grace_days: graceDays,
  };
};
