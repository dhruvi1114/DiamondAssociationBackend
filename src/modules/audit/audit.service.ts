import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { prisma } from '@db/prisma';
import * as repo from '@modules/audit/audit.repository';
import type { AuditLogDto, ListAuditQuery } from '@modules/audit/audit.types';

/**
 * Audit log reads (AJ-10).
 *
 * The whole module answers one question — "who changed this, and from what to
 * what" — and answers it from a table nothing may edit. There is no write path
 * here by design: rows are written by `helpers/audit.ts`, inside the
 * transaction of the change they describe.
 */

/**
 * Both date bounds are inclusive whole days.
 *
 * `from` becomes 00:00:00 on that date and `to` becomes the last instant of its
 * date. Passing the bare date as an upper bound would compare against midnight
 * at its START, so "1 Sep to 1 Sep" would return nothing — the single most
 * likely range anyone types, returning an empty screen that reads as "nothing
 * happened" rather than "you asked for a zero-length window".
 */
const startOfDay = (date?: string): string | undefined =>
  date ? `${date}T00:00:00.000` : undefined;

const endOfDay = (date?: string): string | undefined => (date ? `${date}T23:59:59.999` : undefined);

export const listAuditLogs = async (
  query: ListAuditQuery,
): Promise<{ rows: AuditLogDto[]; total: number }> => {
  const result = await repo.listAuditLogs(prisma, {
    page: query.page,
    limit: query.limit,
    ...(query.entity_name ? { entityName: query.entity_name } : {}),
    ...(query.entity_id ? { entityId: query.entity_id } : {}),
    ...(query.actor_type ? { actorTypes: query.actor_type } : {}),
    ...(query.actor_id ? { actorId: query.actor_id } : {}),
    ...(query.action ? { actions: query.action } : {}),
    ...(startOfDay(query.from) ? { from: startOfDay(query.from) as string } : {}),
    ...(endOfDay(query.to) ? { to: endOfDay(query.to) as string } : {}),
  });

  /*
    Names are resolved for the rows on this page only, in two lookups by primary
    key — never by joining the audit table. See `findAdminNames` for why the
    join would be wrong rather than merely slower.
  */
  const adminIds = [
    ...new Set(
      result.rows
        .filter((row) => row.actor_type === ACTOR_TYPES.ADMIN && row.actor_id !== null)
        .map((row) => row.actor_id as bigint),
    ),
  ];
  const memberIds = [
    ...new Set(
      result.rows
        .filter((row) => row.actor_type === ACTOR_TYPES.MEMBER && row.actor_id !== null)
        .map((row) => row.actor_id as bigint),
    ),
  ];

  const [admins, members] = await Promise.all([
    repo.findAdminNames(prisma, adminIds),
    repo.findMemberNames(prisma, memberIds),
  ]);

  const byType = {
    [ACTOR_TYPES.ADMIN]: new Map(admins.map((row) => [row.id.toString(), row])),
    [ACTOR_TYPES.MEMBER]: new Map(members.map((row) => [row.id.toString(), row])),
  };

  const rows: AuditLogDto[] = result.rows.map((row) => {
    const actorId = row.actor_id === null ? null : row.actor_id.toString();
    const found =
      actorId !== null && row.actor_type !== ACTOR_TYPES.SYSTEM
        ? byType[row.actor_type]?.get(actorId)
        : undefined;

    return {
      id: row.id.toString(),
      actor: {
        type: row.actor_type,
        id: actorId,
        // NULL, not a fabricated label: the screen decides how to word a missing
        // account, and it has more context than this mapper does.
        name: found?.full_name ?? null,
        email: found?.email ?? null,
      },
      action: row.action,
      entity_name: row.entity_name,
      entity_id: row.entity_id === null ? null : row.entity_id.toString(),
      before: row.before_json ?? null,
      after: row.after_json ?? null,
      ip: row.ip,
      user_agent: row.user_agent,
      request_id: row.request_id,
      createdAt: row.createdAt.toISOString(),
    };
  });

  return { rows, total: result.total };
};

/**
 * The filter panel's two option lists.
 *
 * Actions come from the `AUDIT_ACTIONS` constant rather than from a `DISTINCT`
 * over the table — which is exactly why that constant exists. It costs no query,
 * and it lists an action that has never fired yet, so "no notification has ever
 * failed" is answerable by filtering and seeing an empty result rather than by
 * noticing the option is missing.
 *
 * Entity names have no such constant, so they are read from the data.
 */
export const listFacets = async (): Promise<{ actions: string[]; entities: string[] }> => ({
  actions: [...new Set(Object.values(AUDIT_ACTIONS))].sort(),
  entities: await repo.listEntityNames(prisma),
});
