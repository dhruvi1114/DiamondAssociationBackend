import type { NotificationChannel } from '@prisma/client';

/** A template rendered against one row's `payload_json`, ready to hand a channel. */
export interface RenderedNotification {
  notificationId: bigint;
  channel: NotificationChannel;
  templateCode: string;
  /** NULL for channels with no subject line (WhatsApp, in-app). */
  subject: string | null;
  body: string;
  /** NULL for IN_APP, which has no external destination. */
  toAddress: string | null;
}

export interface ChannelSendResult {
  /** Provider-side id, stored for support requests where the provider has one. */
  providerMessageId?: string;
}

/**
 * One delivery mechanism (notification-architecture.md §3).
 *
 * A channel's only job is to hand the message to its provider. It does not
 * decide retries, does not touch the database, and does not know what a
 * template is — the drain owns all of that, so adding WhatsApp in M8 is one
 * file with no changes to the queue.
 */
export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  send(message: RenderedNotification): Promise<ChannelSendResult>;
}
