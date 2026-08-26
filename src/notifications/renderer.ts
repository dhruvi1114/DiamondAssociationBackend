import type { NotificationChannel } from '@prisma/client';
import { environment } from '@config/config';
import { prisma } from '@db/prisma';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { AppError } from '@utils/appError';

/** `{{ placeholder }}` — whitespace tolerated, dotted paths not (deliberately flat). */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type TemplateVariables = Record<string, unknown>;

/**
 * Substitute `{{placeholders}}` from a notification's `payload_json`.
 *
 * Deliberately not a template engine: no conditionals, no loops, no expression
 * evaluation. Template bodies are editable by admins in M8, and anything that
 * evaluates admin-authored strings at render time is a server-side template
 * injection waiting to happen.
 *
 * An unknown placeholder renders as an empty string rather than leaving
 * `{{otp}}` visible in a member's inbox.
 */
export const renderTemplate = (template: string, variables: TemplateVariables): string =>
  template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = variables[name];

    if (value === null || value === undefined) {
      return '';
    }

    return String(value);
  });

export interface ResolvedTemplate {
  subject: string | null;
  body: string;
}

/**
 * Resolve `(code, channel, locale)` to an active template and render it.
 *
 * Locale falls back to the platform default before failing, so a message queued
 * for a locale nobody has authored yet still goes out in English rather than
 * silently rotting in the outbox.
 */
export const resolveAndRender = async (
  code: string,
  channel: NotificationChannel,
  variables: TemplateVariables,
  locale: string = environment.defaultLanguage,
): Promise<ResolvedTemplate> => {
  const template =
    (await prisma.notificationTemplate.findFirst({
      where: { code, channel, locale, is_active: true },
    })) ??
    (locale === environment.defaultLanguage
      ? null
      : await prisma.notificationTemplate.findFirst({
          where: { code, channel, locale: environment.defaultLanguage, is_active: true },
        }));

  if (!template) {
    throw new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: 'communication.templateNotFound',
      sourcePath: `notification template ${code}/${channel}/${locale}`,
    });
  }

  return {
    subject: template.subject ? renderTemplate(template.subject, variables) : null,
    body: renderTemplate(template.body, variables),
  };
};
