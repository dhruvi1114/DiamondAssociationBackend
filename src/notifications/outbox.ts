import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import type { Db } from '@db/prisma';
import type { TemplateVariables } from '@notifications/renderer';

export interface QueueNotificationInput {
  /** `NotificationTemplates.code`, e.g. `auth.signup_otp`. */
  templateCode: string;
  channel: NotificationChannel;
  /** Member recipient. Exactly one of `userId` / `adminUserId` must be set. */
  userId?: bigint | number | null;
  /** Staff recipient. */
  adminUserId?: bigint | number | null;
  /** Organisation the message concerns, for the member's message history. */
  memberId?: bigint | number | null;
  /** Email address or phone number. NULL for IN_APP. */
  toAddress?: string | null;
  /** Template variables. Snapshotted — a later profile edit cannot rewrite it. */
  payload?: TemplateVariables;
}

const toBigInt = (value: bigint | number | null | undefined): bigint | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === 'bigint' ? value : BigInt(value);
};

/**
 * Queue one message (ADR-010, ADR-015).
 *
 * ALWAYS pass the caller's transaction client. The whole point of the outbox is
 * that the message and the business change commit together: an approval that
 * rolls back must not send an approval email, and an approval that commits must
 * not lose its email because SMTP happened to be down. Both properties come
 * from this single `db` parameter being the caller's `tx`.
 *
 *   await prisma.$transaction(async (tx) => {
 *     await approve(tx, applicationId);
 *     await queueNotification(tx, { templateCode: 'application.approved', … });
 *   });
 *
 * Rows land QUEUED with `next_attempt_at = now`, so the next drain sweep — at
 * most 60 seconds later — picks them up.
 */
export const queueNotification = async (
  db: Db,
  input: QueueNotificationInput,
): Promise<{ id: bigint }> => {
  const created = await db.notification.create({
    data: {
      template_code: input.templateCode,
      channel: input.channel,
      user_id: toBigInt(input.userId),
      admin_user_id: toBigInt(input.adminUserId),
      member_id: toBigInt(input.memberId),
      to_address: input.toAddress ?? null,
      payload_json: (input.payload ?? {}) as Prisma.InputJsonValue,
      status: NotificationStatus.QUEUED,
      next_attempt_at: new Date(),
    },
    select: { id: true },
  });

  return created;
};

/**
 * Queue the same message on several channels — the common case, where an
 * approval is both emailed and dropped in the bell feed. One statement per
 * channel, all inside the caller's transaction.
 */
export const queueNotifications = async (
  db: Db,
  channels: NotificationChannel[],
  input: Omit<QueueNotificationInput, 'channel'>,
): Promise<{ id: bigint }[]> => {
  const created: { id: bigint }[] = [];

  for (const channel of channels) {
    created.push(
      await queueNotification(db, {
        ...input,
        channel,
        // IN_APP has no destination; the row itself is the message.
        toAddress: channel === NotificationChannel.IN_APP ? null : input.toAddress,
      }),
    );
  }

  return created;
};
