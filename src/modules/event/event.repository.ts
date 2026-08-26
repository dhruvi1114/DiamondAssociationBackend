import { Prisma } from '@prisma/client';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
import type { ListEventsQuery } from '@modules/event/event.types';

/**
 * Data access for events.
 *
 * Tiers are replaced wholesale on update rather than patched row by row: an edit
 * to the price table is a re-pricing, and any intermediate state where old and
 * new windows coexist would trip the no-overlap exclusion constraint anyway.
 */

export const findEventById = (db: Db, id: bigint) =>
  db.event.findFirst({
    where: { id, deletedAt: null },
    include: { price_tiers: { orderBy: [{ display_order: 'asc' }, { starts_on: 'asc' }] } },
  });

export const findEventBySlug = (db: Db, slug: string) =>
  db.event.findFirst({
    where: { slug, deletedAt: null },
    include: { price_tiers: { orderBy: [{ display_order: 'asc' }, { starts_on: 'asc' }] } },
  });

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
  start_at: Date;
  end_at: Date;
  city: string | null;
  visibility: number;
  status: number;
  capacity: number | null;
  seats_taken: number;
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
    SELECT e."id", e."slug", e."title", e."start_at", e."end_at", e."city",
           e."visibility", e."status", e."capacity", e."seats_taken",
           (SELECT count(*) FROM "EventPriceTiers" t WHERE t."event_id" = e."id") AS tier_count,
           count(*) OVER () AS total
      FROM "Events" e
     WHERE e."deletedAt" IS NULL
       AND (${search}::text IS NULL OR e."title" ILIKE ${search})
       AND (${query.status ?? null}::int IS NULL OR e."status" = ${query.status ?? null})
       AND (${query.visibility ?? null}::int IS NULL OR e."visibility" = ${query.visibility ?? null})
     ORDER BY e."start_at" DESC
     LIMIT ${query.limit} OFFSET ${offset}
  `);
};
