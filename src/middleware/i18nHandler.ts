import type { NextFunction, Request, Response } from 'express';
import i18n from '@locales/index';

/**
 * Negotiates the response language from the `lan` header and binds a
 * locale-aware `__` onto both `req` and `res` (api-conventions.md §3).
 *
 * Mounted before the router so `handleApiResponse` and `ErrorHandler` can both
 * resolve message keys for the caller's locale. An unknown or missing `lan`
 * falls back to the first entry of APP_LANGUAGES.
 */
export const i18nHandler = (req: Request, res: Response, next: NextFunction): void => {
  i18n.init(req, res);
  next();
};
