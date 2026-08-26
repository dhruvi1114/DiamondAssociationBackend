import type { NextFunction, Request, Response } from 'express';
import { API_V1, END_POINTS } from '@constant';
import { decryptToObject } from '@helpers/encryption';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { AppError } from '@utils/appError';

/**
 * Paths that exchange plaintext bodies (api-conventions.md §2).
 *
 * These are the ONLY exceptions and they are still authenticated, authorised
 * and validated — encryption is obfuscation, never authorisation (ADR-004).
 */
const BYPASS_PATH_PREFIXES = [
  `${API_V1}${END_POINTS.HEALTH}`, // uptime monitors cannot decrypt
  `${API_V1}${END_POINTS.WEBHOOKS}`, // provider-signed, provider-shaped bodies
];

const isMultipart = (req: Request): boolean =>
  (req.headers['content-type'] ?? '').toLowerCase().includes('multipart/form-data');

/**
 * True when this request must neither be decrypted on the way in nor encrypted
 * on the way out. Shared by `decryptPayload` and `handleApiResponse` so the two
 * directions can never disagree about a route.
 */
export const isEncryptionBypassed = (req: Request): boolean => {
  if (isMultipart(req)) {
    return true;
  }

  const path = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;

  return BYPASS_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(prefix),
  );
};

/**
 * Replaces `req.body` with the decrypted, parsed payload when the client sent
 * `{ "data": "<ciphertext>" }` (api-conventions.md §2).
 *
 * Runs before validation so every zod schema sees a plain object. A ciphertext
 * that cannot be read is a 400 `INVALID_REQUEST` — never a 500, and never with
 * a reason that would describe the key material.
 *
 * A plaintext body is passed through untouched: uploads, webhooks and health
 * checks legitimately send one, and rejecting it here would duplicate the
 * bypass list in two places.
 */
export const decryptPayload = (req: Request, _res: Response, next: NextFunction): void => {
  if (isEncryptionBypassed(req)) {
    next();
    return;
  }

  const body: unknown = req.body;

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    next();
    return;
  }

  const envelope = body as { data?: unknown };

  if (typeof envelope.data !== 'string') {
    next();
    return;
  }

  const decrypted = decryptToObject<unknown>(envelope.data);

  if (decrypted === null || typeof decrypted !== 'object' || Array.isArray(decrypted)) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'encryption.decryptionError',
    });
  }

  req.body = decrypted as Record<string, unknown>;

  next();
};
