import { Prisma, type ActorType } from '@prisma/client';
import type { Db } from '@db/prisma';

/**
 * Reads of `AuditLogs` (screen A-35, and the History tab on member, application
 * and invoice detail).
 *
 * Read-only on purpose, and permanently: there is no update and no delete here
 * because there is none anywhere. The table has no `updatedAt` and no
 * `deletedAt`, and the application's database role holds no UPDATE or DELETE
 * grant on it.
 *
 * The three indexes this file is written against:
 *   (entity_name, entity_id, createdAt DESC)  — the History tab
 *   (actor_type, actor_id, createdAt DESC)    — "what has this person done"
 *   (createdAt DESC)                          — the unfiltered screen
 * A query that narrows by entity or by actor lands on one of the first two; the
 * default ordering lands on the third. `action` and the date bounds narrow what
 * those return rather than driving the scan, which is why the screen offers a
 * date range beside them.
 */

export interface AuditListParams {
  page: number;
  limit: number;
  entityName?: string;
  entityId?: string;
  actorTypes?: ActorType[];
  actorId?: string;
  actions?: string[];
  /** Inclusive whole days; the caller has already widened `to` to end-of-day. */
  from?: string;
  to?: string;
}

export interface AuditRow {
  id: bigint;
  actor_type: ActorType;
  actor_id: bigint | null;
  action: string;
  entity_name: string;
  entity_id: bigint | null;
  before_json: unknown;
  after_json: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  createdAt: Date;
}

export interface AuditListResult {
  rows: AuditRow[];
  total: number;
}

export const listAuditLogs = async (db: Db, params: AuditListParams): Promise<AuditListResult> => {
  const offset = (params.page - 1) * params.limit;
  const entityName = params.entityName ?? null;
  const entityId = params.entityId ?? null;
  const actorTypes = params.actorTypes?.length ? params.actorTypes : null;
  const actorId = params.actorId ?? null;
  const actions = params.actions?.length ? params.actions : null;
  const from = params.from ?? null;
  const to = params.to ?? null;

  const rows = await db.$queryRaw<(AuditRow & { total: bigint })[]>(Prisma.sql`
    SELECT al."id",
           al."actor_type",
           al."actor_id",
           al."action",
           al."entity_name",
           al."entity_id",
           al."before_json",
           al."after_json",
           al."ip"::text AS ip,
           al."user_agent",
           al."request_id",
           al."createdAt",
           COUNT(*) OVER () AS total
      FROM "AuditLogs" al
     WHERE (${entityName}::text IS NULL OR al."entity_name" = ${entityName}::text)
       AND (${entityId}::bigint IS NULL OR al."entity_id" = ${entityId}::bigint)
       -- Lists, not single values; an empty selection is no filter at all.
       AND (${actorTypes}::text[] IS NULL OR al."actor_type"::text = ANY(${actorTypes}::text[]))
       AND (${actorId}::bigint IS NULL OR al."actor_id" = ${actorId}::bigint)
       AND (${actions}::text[] IS NULL OR al."action" = ANY(${actions}::text[]))
       -- Both bounds inclusive: the service passes the upper bound already
       -- widened to the end of that day, so a one-day range returns that day.
       AND (${from}::timestamptz IS NULL OR al."createdAt" >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR al."createdAt" <= ${to}::timestamptz)
     ORDER BY al."createdAt" DESC, al."id" DESC
     LIMIT ${params.limit} OFFSET ${offset}
  `);

  return {
    rows: rows.map(({ total: _total, ...row }) => row),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
};

export interface ActorName {
  id: bigint;
  full_name: string;
  email: string;
}

/**
 * Names for a page of actor ids — a second query, deliberately **not** a join.
 *
 * `AuditLogs.actor_id` is the one documented soft reference in the schema
 * (ADR-006): no foreign key, because an audit row has to outlive the account
 * that wrote it. Joining would quietly reintroduce the coupling the missing FK
 * exists to avoid, and an inner join would drop exactly the rows a deleted
 * actor makes most interesting.
 *
 * Two small `IN` lookups against the primary key, over at most `limit` ids.
 */
export const findAdminNames = async (db: Db, ids: bigint[]): Promise<ActorName[]> => {
  if (ids.length === 0) return [];

  return db.$queryRaw<ActorName[]>(Prisma.sql`
    SELECT "id", "full_name", "email"::text AS email
      FROM "AdminUsers"
     WHERE "id" IN (${Prisma.join(ids)})
  `);
};

export const findMemberNames = async (db: Db, ids: bigint[]): Promise<ActorName[]> => {
  if (ids.length === 0) return [];

  return db.$queryRaw<ActorName[]>(Prisma.sql`
    SELECT "id", "full_name", "email"::text AS email
      FROM "Users"
     WHERE "id" IN (${Prisma.join(ids)})
  `);
};

/**
 * The entity names that actually appear in the log, for the filter panel.
 *
 * `DISTINCT` over the whole table is the one query here that cannot use an
 * index, so it is bounded two ways: the column is 60 characters and the set is
 * the number of tables in the schema, not the number of rows. Called once when
 * the screen opens, never per keystroke.
 */
export const listEntityNames = async (db: Db): Promise<string[]> => {
  const rows = await db.$queryRaw<{ entity_name: string }[]>(Prisma.sql`
    SELECT DISTINCT "entity_name" FROM "AuditLogs" ORDER BY "entity_name" ASC
  `);

  return rows.map((row) => row.entity_name);
};
