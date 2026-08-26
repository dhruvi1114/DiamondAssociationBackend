import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { TokenAudience } from '@prisma/client';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as captchaService from '@modules/auth/captcha.service';
import * as service from '@modules/auth/auth.service';
import { parseUploadFieldName } from '@modules/auth/register.constants';
import { registerSchema } from '@modules/auth/register.schema';
import * as registerService from '@modules/auth/register.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/**
 * HTTP layer for the auth module: parse, delegate, respond. No business rules.
 *
 * Every handler is wrapped so a rejected promise reaches `ErrorHandler` instead
 * of becoming an unhandled rejection — Express 4 does not await handlers
 * (ADR-014 keeps us on 4, so this is the price and it is paid once, here).
 */
const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

/** The authenticated subject, or a 401 if the middleware was not mounted. */
const actorId = (req: Request): bigint => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return req.actor.id;
};

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

export const signup = handler(async (req, res) => {
  await service.signup(req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    statusCode: 201,
    responseType: RES_STATUS.CREATE,
    messageKey: 'auth.signupSuccess',
  });
});

export const captcha = handler(async (_req, res) => {
  const issued = captchaService.issueCaptcha();

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: issued,
  });
});

export const register = handler(async (req, res) => {
  const rawPayload = req.body?.data ?? req.body?.payload;

  if (typeof rawPayload !== 'string') {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'validation.requiredFields',
    });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'validation.invalidRequest',
    });
  }

  const input = registerSchema.parse(parsed);
  const uploads = req.files as Record<string, Express.Multer.File[]> | undefined;

  /*
    Whatever the checklist accepted, decoded back into (code, face) pairs.

    The route's multer middleware has already rejected any field the live
    checklist does not name, so anything present here is a document type the
    association currently asks for.
  */
  const files = Object.entries(uploads ?? {}).flatMap(([field, list]) => {
    // Not `parsed` — that name already holds the JSON payload above.
    const slot = parseUploadFieldName(field);
    const file = list?.[0];
    if (!slot || !file) return [];

    return [
      {
        code: slot.code,
        side: slot.side,
        originalName: file.originalname,
        buffer: file.buffer,
        declaredMime: file.mimetype,
      },
    ];
  });

  const result = await registerService.register(input, files, service.contextFromRequest(req));

  handleApiResponse(res, {
    statusCode: 201,
    responseType: RES_STATUS.CREATE,
    messageKey: 'auth.registerSuccess',
    data: result,
  });
});

export const setInitialPassword = handler(async (req, res) => {
  await service.setInitialPassword(req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.passwordResetSuccess',
  });
});

export const verifyOtp = handler(async (req, res) => {
  const result = await service.verifyOtp(req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.loginSuccess',
    data: result,
  });
});

export const resendOtp = handler(async (req, res) => {
  await service.resendOtp(req.body);

  handleApiResponse(res, { responseType: RES_STATUS.ACTION, messageKey: 'auth.otpSent' });
});

export const login = handler(async (req, res) => {
  const result = await service.login(req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.loginSuccess',
    data: result,
  });
});

export const refresh = handler(async (req, res) => {
  const result = await service.refreshSession(
    req.body,
    TokenAudience.MEMBER,
    service.contextFromRequest(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.tokenRefreshed',
    data: result,
  });
});

export const logout = handler(async (req, res) => {
  const result = await service.logout(
    req.body,
    { userId: actorId(req) },
    service.contextFromRequest(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.logoutSuccess',
    data: result,
  });
});

export const forgotPassword = handler(async (req, res) => {
  await service.forgotPassword(req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.passwordResetSent',
  });
});

export const resetPassword = handler(async (req, res) => {
  await service.resetPassword(req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.passwordResetSuccess',
  });
});

export const changePassword = handler(async (req, res) => {
  await service.changePassword(actorId(req), req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.passwordChanged',
  });
});

export const me = handler(async (req, res) => {
  const result = await service.me(actorId(req));

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export const adminLogin = handler(async (req, res) => {
  const result = await service.adminLogin(req.body, service.contextFromRequest(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.loginSuccess',
    data: result,
  });
});

export const adminRefresh = handler(async (req, res) => {
  const result = await service.refreshSession(
    req.body,
    TokenAudience.ADMIN,
    service.contextFromRequest(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.tokenRefreshed',
    data: result,
  });
});

export const adminLogout = handler(async (req, res) => {
  const result = await service.logout(
    req.body,
    { adminUserId: actorId(req) },
    service.contextFromRequest(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'auth.logoutSuccess',
    data: result,
  });
});

export const adminMe = handler(async (req, res) => {
  const result = await service.adminMe(actorId(req));

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});
