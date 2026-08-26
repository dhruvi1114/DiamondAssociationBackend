import { NotificationChannel } from '@prisma/client';
import type { NotificationChannelAdapter } from '@notifications/types';
import { emailChannel } from '@notifications/channels/emailChannel';
import { inAppChannel } from '@notifications/channels/inAppChannel';

/**
 * Channel registry. WhatsApp is deliberately absent until OQ-5 is answered:
 * the drain leaves rows for an unregistered channel QUEUED and visible in the
 * admin outbox rather than marking them FAILED, so nothing is silently lost
 * and nothing is falsely reported as delivered (notification-architecture §3).
 */
const registry = new Map<NotificationChannel, NotificationChannelAdapter>([
  [NotificationChannel.EMAIL, emailChannel],
  [NotificationChannel.IN_APP, inAppChannel],
]);

export const getChannel = (channel: NotificationChannel): NotificationChannelAdapter | undefined =>
  registry.get(channel);

export const registeredChannels = (): NotificationChannel[] => [...registry.keys()];

export { emailChannel, inAppChannel };
