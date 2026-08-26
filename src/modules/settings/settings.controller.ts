import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import { handleApiResponse } from '@utils/handleResponse';
import { AppError } from '@utils/appError';

import * as branding from './branding.service';
import * as service from './settings.service';
import type { UpdateSettingsInput } from './settings.types';

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const actor = (req: Request) => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return {
    id: req.actor.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
};

export const listSettings = handler(async (_req, res) => {
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: await service.listSettings() });
});

/** The `is_public` subset, for the sign-in screen and the browser tab. */
export const listPublicSettings = handler(async (_req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: await service.listPublicSettings(),
  });
});

export const updateSettings = handler(async (req, res) => {
  const result = await service.updateSettings(req.body as UpdateSettingsInput, actor(req));

  handleApiResponse(res, { responseType: RES_STATUS.UPDATE, data: result });
});

/* -------------------------------------------------------------------------- */
/* Branding images                                                             */
/* -------------------------------------------------------------------------- */

/** `logo` or `logo-mark`, and nothing else — the slot never reaches storage as a path. */
const slot = (req: Request): branding.BrandingSlot => {
  const raw = req.params.slot ?? '';

  if (!branding.isBrandingSlot(raw)) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'settings.brandingUnknownSlot',
      details: { allowed: Object.keys(branding.BRANDING_SLOTS) },
    });
  }

  return raw;
};

export const uploadBranding = handler(async (req, res) => {
  if (!req.file) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'settings.brandingFileRequired',
    });
  }

  const data = await branding.putBranding(slot(req), req.file, actor(req));

  handleApiResponse(res, { responseType: RES_STATUS.UPDATE, data });
});

export const removeBranding = handler(async (req, res) => {
  const data = await branding.clearBranding(slot(req), actor(req));

  handleApiResponse(res, { responseType: RES_STATUS.DELETE, data });
});

/**
 * Serve a branding image to anyone, signed in or not.
 *
 * Public because the two places it is needed — the login screen and an invoice —
 * have no session to check. Safe because the slot is validated against a
 * two-entry map before anything is read, so no request can name a file.
 *
 * `inline`, unlike every other file this platform serves: the point is for a
 * browser to render it in an `<img>`. That is only acceptable because the bytes
 * were sniffed on upload and SVG is refused — there is no markup here to
 * execute. `nosniff` holds the browser to the type we declare.
 */
export const serveBranding = handler(async (req, res) => {
  const file = await branding.readBranding(slot(req));

  // The storage key changes on every upload, so it identifies the bytes exactly:
  // a browser holding the old logo revalidates and gets the new one immediately.
  const etag = `"${file.key}"`;

  res.setHeader('ETag', etag);
  // `no-cache` is "keep it, but ask every time" — NOT "do not store". It has to be
  // that, because this is a mutable resource at a fixed URL: with a max-age the
  // browser answers from its own copy without asking, and a logo that was removed
  // or replaced goes on showing in the sidebar until the age runs out. Revalidation
  // is cheap — the ETag makes the usual answer a 304 with no body.
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();

    return;
  }

  res.setHeader('Content-Disposition', 'inline');
  file.stream.pipe(res);
});
