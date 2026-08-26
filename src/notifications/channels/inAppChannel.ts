import { NotificationChannel } from '@prisma/client';
import type {
  ChannelSendResult,
  NotificationChannelAdapter,
  RenderedNotification,
} from '@notifications/types';

/**
 * In-app delivery (notification-architecture.md §6).
 *
 * There is no provider: the `Notifications` row **is** the member's bell-feed
 * item. Marking it SENT is what makes it visible; `read_at` is set when the
 * member opens it. This adapter therefore does nothing except succeed — which
 * is the point, because it lets the drain treat every channel identically.
 */
export class InAppChannel implements NotificationChannelAdapter {
  public readonly channel = NotificationChannel.IN_APP;

  async send(message: RenderedNotification): Promise<ChannelSendResult> {
    return { providerMessageId: `in-app-${message.notificationId}` };
  }
}

export const inAppChannel = new InAppChannel();
