import nodemailer, { type Transporter } from 'nodemailer';
import { NotificationChannel } from '@prisma/client';
import { environment } from '@config/config';
import { logger } from '@logger/logger';
import type {
  ChannelSendResult,
  NotificationChannelAdapter,
  RenderedNotification,
} from '@notifications/types';

/**
 * Email delivery via nodemailer.
 *
 * `MAIL_TRANSPORT=console` logs the envelope instead of sending — the interim
 * transport until real SMTP credentials arrive (A-13). It logs recipient,
 * subject and template code only: bodies routinely carry OTPs and reset links,
 * which observability.md §3 forbids writing to a log.
 *
 * A send failure throws. The drain owns the retry policy, so a channel that
 * swallowed errors would silently mark undelivered mail as SENT.
 */
export class EmailChannel implements NotificationChannelAdapter {
  public readonly channel = NotificationChannel.EMAIL;

  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (this.transporter) {
      return this.transporter;
    }

    this.transporter = nodemailer.createTransport({
      host: environment.mail.host,
      port: environment.mail.port,
      secure: environment.mail.secure,
      auth: environment.mail.user
        ? { user: environment.mail.user, pass: environment.mail.password }
        : undefined,
    });

    return this.transporter;
  }

  async send(message: RenderedNotification): Promise<ChannelSendResult> {
    if (!message.toAddress) {
      throw new Error('EMAIL notification has no to_address');
    }

    if (environment.mail.transport === 'console') {
      logger.info('notification.email.console', {
        notificationId: message.notificationId.toString(),
        templateCode: message.templateCode,
        to: message.toAddress,
        subject: message.subject,
        bodyLength: message.body.length,
      });

      return { providerMessageId: `console-${message.notificationId}` };
    }

    const info = await this.getTransporter().sendMail({
      from: environment.mail.from,
      to: message.toAddress,
      subject: message.subject ?? '',
      text: message.body,
    });

    return { providerMessageId: info.messageId };
  }

  /** Used by `/health/ready` in environments that actually send mail. */
  async verify(): Promise<boolean> {
    if (environment.mail.transport === 'console') {
      return true;
    }

    try {
      await this.getTransporter().verify();

      return true;
    } catch (error) {
      logger.error('notification.email.verifyFailed', {
        detail: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }
}

export const emailChannel = new EmailChannel();
