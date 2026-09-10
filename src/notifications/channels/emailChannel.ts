import nodemailer, { type Transporter } from 'nodemailer';
import { NotificationChannel } from '@prisma/client';
import { environment } from '@config/config';
import { logger } from '@logger/logger';
import type {
  ChannelSendResult,
  NotificationChannelAdapter,
  RenderedNotification,
} from '@notifications/types';
import { ctaLabelFor } from '@notifications/emailCta';
import { loadBranding, renderEmailHtml, toPlainText } from '@notifications/emailLayout';

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
 *
 * Every message goes out **multipart**: the template body verbatim as `text`,
 * and that same body poured into the card in `emailLayout.ts` as `html`. Both
 * halves, always. HTML-only mail is treated as a spam signal by several
 * providers, and a client set to prefer text — or a screen reader — reads the
 * text half. The layout is applied here rather than in the templates so all
 * forty share one design and none of them has to hold markup.
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

    const branding = await loadBranding();
    const html = renderEmailHtml({
      body: message.body,
      ctaLabel: ctaLabelFor(message.templateCode),
      branding,
    });

    const info = await this.getTransporter().sendMail({
      from: environment.mail.from,
      to: message.toAddress,
      /*
        Only set where the message is sent on somebody else's behalf. `from` is
        always the platform's own account — putting a visitor's address there
        would be forgery and every mail provider rejects it — so `replyTo` is
        how Reply reaches the person who actually wrote.
      */
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject ?? '',
      text: toPlainText(message.body),
      html,
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
