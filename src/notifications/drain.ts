import { NotificationStatus, Prisma } from '@prisma/client';
import { prisma } from '@db/prisma';
import { logger } from '@logger/logger';
import { getChannel, registeredChannels } from '@notifications/channels';
import { resolveAndRender, type TemplateVariables } from '@notifications/renderer';
import type { RenderedNotification } from '@notifications/types';

/** notification-architecture.md §2/§8. */
export const DRAIN_BATCH_SIZE = 50;
export const MAX_ATTEMPTS = 5;

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  retrying: number;
}

/**
 * Backoff: now + 2^attempt minutes → 2, 4, 8, 16 minutes across the retry
 * budget. Long enough that a restarting mail server is given room, short enough
 * that a member is not left waiting on an OTP for an hour.
 */
const nextAttemptAt = (attemptCount: number): Date =>
  new Date(Date.now() + 2 ** attemptCount * 60_000);

/**
 * Claim up to `batchSize` due rows.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run more than once
 * concurrently: a second sweep steps over rows the first has already claimed
 * instead of blocking on them or, worse, sending the same email twice. The
 * claim flips the rows to SENDING in the same transaction as the SELECT, so a
 * crash between claim and send leaves them visibly stuck in SENDING rather than
 * silently re-queued.
 *
 * Channels with no registered adapter (WhatsApp until OQ-5) are excluded from
 * the claim entirely: their rows stay QUEUED and visible in the admin outbox
 * instead of burning the retry budget against an adapter that does not exist.
 */
const claimBatch = async (batchSize: number): Promise<bigint[]> =>
  prisma.$transaction(async (tx) => {
    const channels = registeredChannels();

    if (channels.length === 0) {
      return [];
    }

    const rows = await tx.$queryRaw<{ id: bigint }[]>(
      Prisma.sql`
        SELECT "id"
        FROM "Notifications"
        WHERE "status" = ${NotificationStatus.QUEUED}::"NotificationStatus"
          AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= now())
          AND "channel" IN (${Prisma.join(
            channels.map((channel) => Prisma.sql`${channel}::"NotificationChannel"`),
          )})
        ORDER BY "next_attempt_at" ASC NULLS FIRST, "id" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `,
    );

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);

    await tx.$executeRaw(
      Prisma.sql`
        UPDATE "Notifications"
        SET "status" = ${NotificationStatus.SENDING}::"NotificationStatus",
            "updatedAt" = now()
        WHERE "id" IN (${Prisma.join(ids)})
      `,
    );

    return ids;
  });

const markSent = (id: bigint, providerMessageId?: string): Promise<unknown> =>
  prisma.notification.update({
    where: { id },
    data: {
      status: NotificationStatus.SENT,
      sent_at: new Date(),
      next_attempt_at: null,
      error: providerMessageId ? `providerMessageId=${providerMessageId}` : null,
    },
  });

const markFailure = async (
  id: bigint,
  attemptCount: number,
  reason: string,
): Promise<'retrying' | 'failed'> => {
  const attempts = attemptCount + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;

  await prisma.notification.update({
    where: { id },
    data: {
      status: exhausted ? NotificationStatus.FAILED : NotificationStatus.QUEUED,
      attempt_count: attempts,
      next_attempt_at: exhausted ? null : nextAttemptAt(attempts),
      // Provider message only — never a stack trace and never the rendered body.
      error: reason.slice(0, 1000),
    },
  });

  return exhausted ? 'failed' : 'retrying';
};

/**
 * One drain sweep (notification-architecture.md §2).
 *
 * Each row is dispatched independently: one bad template or one rejected
 * address must not stop the other 49. Nothing here is logged that could carry a
 * secret — template code, recipient id and status only (§8), never the payload,
 * which routinely holds an OTP.
 */
export const drainNotifications = async (
  batchSize: number = DRAIN_BATCH_SIZE,
): Promise<DrainResult> => {
  const ids = await claimBatch(batchSize);
  const result: DrainResult = { claimed: ids.length, sent: 0, failed: 0, retrying: 0 };

  for (const id of ids) {
    const row = await prisma.notification.findUnique({ where: { id } });

    if (!row) {
      continue;
    }

    try {
      const adapter = getChannel(row.channel);

      if (!adapter) {
        throw new Error(`no adapter registered for channel ${row.channel}`);
      }

      const rendered = await resolveAndRender(
        row.template_code,
        row.channel,
        (row.payload_json ?? {}) as TemplateVariables,
      );

      const message: RenderedNotification = {
        notificationId: row.id,
        channel: row.channel,
        templateCode: row.template_code,
        subject: rendered.subject,
        body: rendered.body,
        toAddress: row.to_address,
      };

      const sendResult = await adapter.send(message);

      await markSent(row.id, sendResult.providerMessageId);
      result.sent += 1;

      logger.info('notification.sent', {
        notificationId: row.id.toString(),
        channel: row.channel,
        templateCode: row.template_code,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const outcome = await markFailure(row.id, row.attempt_count, reason);

      result[outcome] += 1;

      logger.warn('notification.deliveryFailed', {
        notificationId: row.id.toString(),
        channel: row.channel,
        templateCode: row.template_code,
        attempt: row.attempt_count + 1,
        outcome,
        detail: reason,
      });
    }
  }

  return result;
};
