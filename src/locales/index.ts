import path from 'path';
import { I18n } from 'i18n';
import { environment } from '@config/config';

/**
 * i18n instance shared by the whole backend.
 *
 * Locale resolution: the `lan` request header (api-conventions.md §3), falling
 * back to the first entry of APP_LANGUAGES. Every user-facing string — success
 * messages, AppError messages, validation messages — resolves through this
 * instance; string literals are not allowed in controllers or services.
 *
 * `updateFiles: false` keeps the catalogue authoritative: a missing key is a
 * bug to fix in en.json, never something the runtime silently appends.
 *
 * `objectNotation: true` is what makes `__('auth.loginSuccess')` walk into the
 * nested namespace rather than looking for a literal key with a dot in it.
 */
export const i18n = new I18n({
  locales: [...environment.languages],
  directory: path.join(__dirname),
  // i18n 0.15 names this option `header`; it is the `lan` header, not
  // `accept-language`, because the frontends set the locale explicitly.
  header: 'lan',
  defaultLocale: environment.defaultLanguage,
  objectNotation: true,
  autoReload: environment.isLocal,
  updateFiles: false,
  syncFiles: false,
  retryInDefaultLocale: true,
});

/**
 * Namespaces published by `src/locales/en.json`. Kept as a const tuple so a
 * typo in `t('aut.loginSuccess')` fails at compile time.
 */
export const I18N_NAMESPACES = [
  'common',
  'auth',
  'member',
  'application',
  'approval',
  'billing',
  'payment',
  'renewal',
  'event',
  'communication',
  'directory',
  'rbac',
  'document',
  'encryption',
  'validation',
] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

/**
 * Resolve a translation key of the form `<namespace>.<key>`.
 *
 * Always prefer the request-scoped `req.t(...)` (attached by the `i18nHandler`
 * middleware) so the caller's `lan` header is honoured. This module-level
 * helper exists for jobs and startup code, which have no request.
 */
export const t = (key: string, replacements?: Record<string, string>): string =>
  replacements ? i18n.__(key, replacements) : i18n.__(key);

export default i18n;
