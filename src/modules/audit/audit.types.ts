import { ActorType } from '@prisma/client';
import { z } from 'zod';

/**
 * Query schema and DTOs for the audit log (AJ-10, screen A-35).
 *
 * Everything here is read-only by design. `AuditLogs` has no update and no
 * delete path anywhere in the codebase, and the app's database role holds no
 * UPDATE or DELETE grant on the table — so there is nothing to write a body
 * schema for.
 */

/**
 * A repeated filter arrives as `?actor_type=ADMIN,SYSTEM`. Split, trim and drop
 * blanks, so a trailing comma or an empty selection is an absent filter rather
 * than a 422.
 */
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(item).nonempty().optional());

/** `YYYY-MM-DD`, as a date filter arrives on the query string. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'validation.invalidDate')
  .optional();

const numericId = z.string().regex(/^\d+$/, 'validation.invalidId').optional();

export const listAuditSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Clamped rather than rejected (api-conventions.md §6).
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(20)
    .transform((value) => Math.min(value, 100)),

  /**
   * The subject of the change: a table name, exactly as it was written —
   * `Applications`, `Members`. Exact match, not a LIKE: the value comes from a
   * fixed list the screen offers, and a partial match would silently fold
   * `Members` and `MemberAddresses` into one answer.
   */
  entity_name: z.string().trim().min(1).max(60).optional(),
  entity_id: numericId,

  actor_type: csv(z.nativeEnum(ActorType)),
  actor_id: numericId,

  /** Codes from `AUDIT_ACTIONS`, which `GET /admin/audit/actions` enumerates. */
  action: csv(z.string().trim().min(1).max(80)),

  /**
   * Both bounds are **inclusive whole days**, in the server's timezone: `to`
   * covers everything up to 23:59:59.999 on that date, not midnight at its
   * start. A range of one day therefore returns that day's rows, which is the
   * only reading that does not surprise the person typing it.
   */
  from: dateOnly,
  to: dateOnly,
});

export type ListAuditQuery = z.infer<typeof listAuditSchema>;

/** Who did it, resolved for display. */
export interface AuditActorDto {
  type: ActorType;
  /** NULL for SYSTEM, and for a row whose actor id was never recorded. */
  id: string | null;
  /**
   * The actor's name at read time, or NULL when the account no longer exists.
   * A deleted actor is a normal outcome here — the row deliberately outlives
   * them (ADR-006) — so the screen says "Deleted account" rather than failing.
   */
  name: string | null;
  email: string | null;
}

export interface AuditLogDto {
  id: string;
  actor: AuditActorDto;
  action: string;
  entity_name: string;
  entity_id: string | null;
  /** Only the fields that changed. NULL for a create. */
  before: unknown;
  /** Only the fields that changed. NULL for a delete. */
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  createdAt: string;
}
