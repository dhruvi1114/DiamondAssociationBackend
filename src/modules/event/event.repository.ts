import { MemberStatus, Prisma } from '@prisma/client';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
import { EVENT_STATUS, EVENT_VISIBILITY } from '@modules/event/event.constants';
import type { ListEventsQuery } from '@modules/event/event.types';

/** Pulled out so the raw statements read as SQL rather than as string building. */
const EVENT_STATUS_PUBLISHED = EVENT_STATUS.PUBLISHED;
const EVENT_VISIBILITY_PUBLIC = EVENT_VISIBILITY.PUBLIC;

/**
 * Data access for events.
 *
 * Tiers are replaced wholesale on update rather than patched row by row: an edit
 * to the price table is a re-pricing, and any intermediate state where old and
 * new windows coexist would trip the no-overlap exclusion constraint anyway.
 */

/*
  The type comes back as its name, on both readers. Every caller of these two
  renders the event for a person — the admin form, the member page, the public
  page — and not one of them has any use for the id on its own.
*/
const eventInclude = {
  price_tiers: { orderBy: [{ display_order: 'asc' }, { starts_on: 'asc' }] },
  event_type: { select: { id: true, name: true } },
} satisfies Prisma.EventInclude;

export const findEventById = (db: Db, id: bigint) =>
  db.event.findFirst({ where: { id, deletedAt: null }, include: eventInclude });

export const findEventBySlug = (db: Db, slug: string) =>
  db.event.findFirst({ where: { slug, deletedAt: null }, include: eventInclude });

export const slugExists = async (db: Db, slug: string): Promise<boolean> =>
  (await db.event.count({ where: { slug } })) > 0;

export const createEvent = (db: Db, data: Prisma.EventUncheckedCreateInput) =>
  db.event.create({ data });

export const updateEvent = (db: Db, id: bigint, data: Prisma.EventUncheckedUpdateInput) =>
  db.event.update({ where: { id }, data });

export const deleteTiersForEvent = (db: Db, eventId: bigint) =>
  db.eventPriceTier.deleteMany({ where: { event_id: eventId } });

export const createTiers = (db: Db, rows: Prisma.EventPriceTierUncheckedCreateInput[]) =>
  db.eventPriceTier.createMany({ data: rows });

export interface AdminEventRow {
  id: bigint;
  slug: string;
  title: string;
  description: string | null;
  start_at: Date;
  end_at: Date;
  venue_name: string | null;
  city: string | null;
  registration_closes_at: Date | null;
  requires_approval: boolean;
  visibility: number;
  status: number;
  capacity: number | null;
  seats_taken: number;
  event_type_id: bigint | null;
  event_type: string | null;
  createdAt: Date;
  updatedAt: Date;
  created_by: string | null;
  updated_by: string | null;
  tier_count: bigint;
  total: bigint;
}

/**
 * The admin list, as one statement with a windowed count.
 *
 * The alternative — fetch the page, then count tiers per event — is the N+1 that
 * turns a 50-event list into 51 queries (ADR-005).
 */
export const listEventsAdmin = async (query: ListEventsQuery): Promise<AdminEventRow[]> => {
  const offset = (query.page - 1) * query.limit;
  const search = query.search ? `%${query.search}%` : null;

  return prisma.$queryRaw<AdminEventRow[]>(Prisma.sql`
    SELECT e."id", e."slug", e."title", e."description", e."start_at", e."end_at",
           e."venue_name", e."city", e."registration_closes_at", e."requires_approval",
           e."visibility", e."status", e."capacity", e."seats_taken",
           e."event_type_id",
           -- The type's NAME, not its id, for the same reason the staff names
           -- are resolved below: a column reading "4" is not a kind of event.
           et."name" AS event_type,
           e."createdAt", e."updatedAt",
           /*
             The staff names, not the ids. A column reading "3" tells an admin
             nothing; resolving here costs one join rather than a lookup per row.
           */
           ca."full_name" AS created_by,
           ua."full_name" AS updated_by,
           (SELECT count(*) FROM "EventPriceTiers" t WHERE t."event_id" = e."id") AS tier_count,
           count(*) OVER () AS total
      FROM "Events" e
      LEFT JOIN "AdminUsers" ca ON ca."id" = e."created_by_admin_id"
      LEFT JOIN "AdminUsers" ua ON ua."id" = e."updated_by_admin_id"
      LEFT JOIN "EventTypes" et ON et."id" = e."event_type_id"
     WHERE e."deletedAt" IS NULL
       AND (${search}::text IS NULL OR e."title" ILIKE ${search})
       AND (${query.status ?? null}::int IS NULL OR e."status" = ${query.status ?? null})
       AND (${query.visibility ?? null}::int IS NULL OR e."visibility" = ${query.visibility ?? null})
     ORDER BY e."start_at" DESC
     LIMIT ${query.limit} OFFSET ${offset}
  `);
};

/**
 * How many people a publish will reach.
 *
 * Counted at publish time and returned with the result, because the admin
 * confirmation dialog states the number *before* the click — this is the record
 * of what was actually announced. Members-only and public events reach the same
 * member base; the difference is whether the public can also see it, which no
 * count can express.
 */
export const countPublishAudience = (db: Db): Promise<number> =>
  db.member.count({ where: { status: MemberStatus.ACTIVE, deletedAt: null } });

export interface BrowseEventRow {
  id: bigint;
  slug: string;
  title: string;
  /** Storage key. The service turns it into the URL the browser asks for. */
  banner_path: string | null;
  banner_alt: string | null;
  /** The type's NAME, resolved here — an id on a card tells a reader nothing. */
  event_type: string | null;
  start_at: Date;
  end_at: Date;
  venue_name: string | null;
  city: string | null;
  visibility: number;
  capacity: number | null;
  seats_taken: number;
  registration_closes_at: Date | null;
  member_price: Prisma.Decimal | null;
  non_member_price: Prisma.Decimal | null;
  tier_name: string | null;
  total: bigint;
}

/**
 * One browse statement, shared by the public and member listings.
 *
 * `publicOnly` decides whether members-only events are in scope, and it goes
 * into the WHERE clause rather than being filtered afterwards: an event the
 * public may not see must never leave the database, or a paging bug becomes a
 * disclosure bug.
 *
 * The lateral join attaches today's tier, so the list can show a real price
 * without a second query per row.
 */
/**
 * What the events page may be narrowed by.
 *
 * Every one of these is applied in SQL. A filter that ran after fetching could
 * only ever see the twenty rows already on the page, so "Conferences in Surat"
 * would silently mean "conferences in Surat among the next twenty events".
 *
 * All optional, and an absent filter is a filter that is not applied — an empty
 * array means "no opinion", not "match nothing".
 */
export interface BrowseFilters {
  /** `EventTypes.id`. Several, because "conference OR seminar" is a real question. */
  typeIds?: bigint[];
  cities?: string[];
  /** Events starting on or after this day. */
  from?: Date;
  /** Events starting on or before this day. */
  to?: Date;
  /** 'free' | 'paid'. Judged on today's tier, which is what the card shows. */
  price?: 'free' | 'paid';
  /** Only events a reader can still book: open window, seats left. */
  openOnly?: boolean;
}

const browseEvents = (
  publicOnly: boolean,
  page: number,
  limit: number,
  upcomingOnly: boolean,
  filters: BrowseFilters = {},
) => {
  const offset = (page - 1) * limit;

  /*
    Each filter is one predicate that is either the real test or `TRUE`. Written
    this way the statement stays a single prepared query with a stable plan,
    rather than a string assembled differently for every combination of filters
    somebody ticks.
  */
  const typeIds = filters.typeIds?.length ? filters.typeIds : null;
  const cities = filters.cities?.length ? filters.cities : null;

  return prisma.$queryRaw<BrowseEventRow[]>(Prisma.sql`
    SELECT e."id", e."slug", e."title", e."banner_path", e."banner_alt",
           et."name" AS event_type,
           e."start_at", e."end_at", e."venue_name", e."city",
           e."visibility", e."capacity", e."seats_taken", e."registration_closes_at",
           t."member_price", t."non_member_price", t."name" AS tier_name,
           count(*) OVER () AS total
      FROM "Events" e
      LEFT JOIN "EventTypes" et ON et."id" = e."event_type_id"
      LEFT JOIN LATERAL (
        SELECT p."member_price", p."non_member_price", p."name"
          FROM "EventPriceTiers" p
         WHERE p."event_id" = e."id"
           AND current_date BETWEEN p."starts_on" AND p."ends_on"
         LIMIT 1
      ) t ON TRUE
     WHERE e."deletedAt" IS NULL
       AND e."status" = ${EVENT_STATUS_PUBLISHED}
       AND (${publicOnly}::boolean = false OR e."visibility" = ${EVENT_VISIBILITY_PUBLIC})
       AND (${upcomingOnly}::boolean = false OR e."end_at" >= now())
       AND (${typeIds}::bigint[] IS NULL OR e."event_type_id" = ANY(${typeIds}::bigint[]))
       AND (${cities}::text[] IS NULL OR e."city" = ANY(${cities}::text[]))
       AND (${filters.from ?? null}::timestamptz IS NULL OR e."start_at" >= ${filters.from ?? null}::timestamptz)
       AND (${filters.to ?? null}::timestamptz IS NULL OR e."start_at" <= ${filters.to ?? null}::timestamptz)
       /*
         Free means today's tier costs nothing for either audience. An event with
         no tier covering today has no price at all, which is not the same as
         free — it cannot be booked, so it is neither.
       */
       AND (
         ${filters.price ?? null}::text IS NULL
         OR (${filters.price ?? null}::text = 'free'
             AND t."member_price" = 0 AND t."non_member_price" = 0)
         OR (${filters.price ?? null}::text = 'paid'
             AND (t."member_price" > 0 OR t."non_member_price" > 0))
       )
       /*
         Bookable today: a tier applies, the deadline has not passed, and there
         is at least one seat. Capacity NULL is unlimited, not full.
       */
       AND (
         ${filters.openOnly ?? false}::boolean = false
         OR (t."name" IS NOT NULL
             AND (e."registration_closes_at" IS NULL OR e."registration_closes_at" >= now())
             AND (e."capacity" IS NULL OR e."capacity" > e."seats_taken"))
       )
     ORDER BY e."start_at" ASC
     LIMIT ${limit} OFFSET ${offset}
  `);
};

/**
 * The facets the filter rail offers.
 *
 * Only values that actually occur in the events this audience can see. A type
 * with no events behind it is a filter that leads to an empty page — a promise
 * the screen does not keep — and a city list drawn from the master would name
 * places the association has never held an event in.
 */
export interface BrowseFacets {
  types: { id: string; name: string; count: number }[];
  cities: { name: string; count: number }[];
}

export const browseFacets = async (publicOnly: boolean): Promise<BrowseFacets> => {
  const [types, cities] = await Promise.all([
    prisma.$queryRaw<{ id: bigint; name: string; count: bigint }[]>(Prisma.sql`
      SELECT et."id", et."name", count(*) AS count
        FROM "Events" e
        JOIN "EventTypes" et ON et."id" = e."event_type_id"
       WHERE e."deletedAt" IS NULL
         AND e."status" = ${EVENT_STATUS_PUBLISHED}
         AND e."end_at" >= now()
         AND (${publicOnly}::boolean = false OR e."visibility" = ${EVENT_VISIBILITY_PUBLIC})
       GROUP BY et."id", et."name", et."display_order"
       ORDER BY et."display_order" ASC, et."name" ASC
    `),
    prisma.$queryRaw<{ name: string; count: bigint }[]>(Prisma.sql`
      SELECT e."city" AS name, count(*) AS count
        FROM "Events" e
       WHERE e."deletedAt" IS NULL
         AND e."status" = ${EVENT_STATUS_PUBLISHED}
         AND e."end_at" >= now()
         AND e."city" IS NOT NULL
         AND (${publicOnly}::boolean = false OR e."visibility" = ${EVENT_VISIBILITY_PUBLIC})
       GROUP BY e."city"
       ORDER BY count(*) DESC, e."city" ASC
    `),
  ]);

  return {
    types: types.map((row) => ({
      id: row.id.toString(),
      name: row.name,
      count: Number(row.count),
    })),
    cities: cities.map((row) => ({ name: row.name, count: Number(row.count) })),
  };
};

/** Published, public events only — for visitors with no session. */
export const listPublicEvents = (page: number, limit: number, filters?: BrowseFilters) =>
  browseEvents(true, page, limit, true, filters);

/** Published events of both kinds — for a signed-in member. */
export const listMemberEvents = (page: number, limit: number, filters?: BrowseFilters) =>
  browseEvents(false, page, limit, true, filters);

/**
 * One public event by slug, or null.
 *
 * Null rather than a forbidden error: a 403 confirms the event exists, and a
 * members-only AGM should be indistinguishable from a mistyped URL.
 */
export const findPublicEventBySlug = (db: Db, slug: string) =>
  db.event.findFirst({
    where: {
      slug,
      deletedAt: null,
      status: EVENT_STATUS_PUBLISHED,
      visibility: EVENT_VISIBILITY_PUBLIC,
    },
    include: eventInclude,
  });

/** One published event of either visibility, for a signed-in member. */
export const findMemberEventBySlug = (db: Db, slug: string) =>
  db.event.findFirst({
    where: { slug, deletedAt: null, status: EVENT_STATUS_PUBLISHED },
    include: eventInclude,
  });
