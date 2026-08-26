import type { Response } from 'express';
import { t } from '@locales/index';

/**
 * Resolve an i18n key against the locale negotiated for THIS response.
 *
 * `i18n.init` binds a locale-aware `__` to both `req` and `res` from the `lan`
 * header (api-conventions.md §3). Falling back to the module-level `t` keeps
 * this callable from jobs and startup code, which have no request.
 */
export const translate = (
  res: Response | undefined,
  key: string,
  replacements?: Record<string, string>,
): string => {
  const localised = res?.__;

  if (typeof localised === 'function') {
    return replacements ? localised(key, replacements) : localised(key);
  }

  return t(key, replacements);
};
