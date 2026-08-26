import type { Request } from 'express';
import { ACTOR_TYPES, type ActorType } from '@constant/audit.constant';
import { prisma, type Db } from '@db/prisma';
import { logger } from '@logger/logger';
import { getRequestContext } from '@logger/requestContext';
import { redact } from '@logger/redact';

export interface AuditEntry {
  /** `<entity>.<past-tense-verb>`, from `AUDIT_ACTIONS` where one exists. */
  action: string;
  /** Table name of the subject, e.g. `Members`. */
  entityName: string;
  /** Primary key of the subject row. Omitted only when nothing was written. */
  entityId?: bigint | number | null;
  /** Only the fields that changed. NULL/omitted for a create. */
  before?: unknown;
  /** Only the fields that changed. NULL/omitted for a delete. */
  after?: unknown;
  actorType?: ActorType;
  actorId?: bigint | number | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

const MAX_USER_AGENT_LENGTH = 512;

const toBigInt = (value: bigint | number | null | undefined): bigint | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'bigint' ? value : BigInt(value);
};

/**
 * `AuditLogs` is a business record, not a log line (observability.md §1). It
 * answers "who changed this, from what to what" and is retained long after the
 * application logs have rotated away.
 *
 * Transaction-aware by design: pass the caller's `tx` and the audit row commits
 * or rolls back with the change it describes. A `writeAudit` that used the root
 * client would happily record an approval that was subsequently rolled back.
 *
 *   await prisma.$transaction(async (tx) => {
 *     const updated = await approve(tx, id);
 *     await writeAudit(tx, { action: 'application.approved', … });
 *   });
 *
 * `before`/`after` go through the same redaction denylist as the logger, so a
 * careless `after: user` cannot persist a password hash into the audit trail.
 */
export const writeAudit = async (db: Db, entry: AuditEntry): Promise<void> => {
  const context = getRequestContext();

  await db.auditLog.create({
    data: {
      actor_type: entry.actorType ?? ACTOR_TYPES.SYSTEM,
      actor_id: toBigInt(entry.actorId),
      action: entry.action,
      entity_name: entry.entityName,
      entity_id: toBigInt(entry.entityId),
      before_json: entry.before === undefined ? undefined : (redact(entry.before) as never),
      after_json: entry.after === undefined ? undefined : (redact(entry.after) as never),
      ip: entry.ip ?? null,
      user_agent: entry.userAgent ? entry.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      request_id: entry.requestId ?? context?.requestId ?? null,
    },
  });
};

/**
 * Fills actor, ip, user-agent and requestId from the request so callers state
 * only what actually happened. Still transaction-aware — `db` is the caller's tx.
 */
export const writeAuditFromRequest = (
  db: Db,
  req: Request,
  entry: Omit<AuditEntry, 'actorType' | 'actorId' | 'ip' | 'userAgent' | 'requestId'>,
): Promise<void> =>
  writeAudit(db, {
    ...entry,
    actorType: req.actor?.type ?? ACTOR_TYPES.SYSTEM,
    actorId: req.actor?.id ?? null,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  });

/**
 * Audit an action that has already committed and must not be able to fail the
 * caller — a download, for instance, where the file has already been streamed.
 * A write failure is logged loudly rather than thrown.
 */
export const writeAuditBestEffort = async (entry: AuditEntry): Promise<void> => {
  try {
    await writeAudit(prisma, entry);
  } catch (error) {
    logger.error('audit.writeFailed', {
      action: entry.action,
      entityName: entry.entityName,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};
