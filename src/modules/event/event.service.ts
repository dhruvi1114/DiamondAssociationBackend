import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { EVENT_STATUS } from '@modules/event/event.constants';
import * as repo from '@modules/event/event.repository';
import { AppError } from '@utils/appError';
import type {
  CreateEventInput,
  ListEventsQuery,
  UpdateEventInput,
} from '@modules/event/event.types';
import type { Db } from '@db/prisma';

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
  description: input.description ?? null,
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
      updated_by_admin_id: actor.id,
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
export const getEvent = async (id: bigint) => {
  const event = await repo.findEventById(prisma, id);

  if (!event) throw notFound();

  return event;
};

/** The admin list, paged. */
export const listEvents = async (query: ListEventsQuery) => {
  const rows = await repo.listEventsAdmin(query);

  return {
    rows: rows.map(({ total: _total, ...row }) => row),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
};
