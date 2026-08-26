import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { authenticate, authenticateAdmin, rateLimiters, validateRequest } from '@middleware';
import * as controller from '@modules/auth/auth.controller';
import { uploadFieldName } from '@modules/auth/register.constants';
import { requiredSides } from '@modules/document/document.sides';
import { checklistFor } from '@modules/masters/masters.checklist';
import {
  adminLoginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  resendOtpSchema,
  resetPasswordSchema,
  signupSchema,
  verifyOtpSchema,
} from '@modules/auth/auth.types';
import { setInitialPasswordSchema } from '@modules/auth/register.schema';

const upload = multer({
  storage: multer.memoryStorage(),
  // Per-file ceiling only. The real limit is the document type's own max_size_mb,
  // checked against the bytes in document.service; this is the backstop that stops
  // a huge body being buffered before we get that far.
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * Accept exactly the files the live checklist asks for.
 *
 * Built per request because an admin can add a document type at any moment and
 * the next applicant must be able to send it. Still a whitelist: a field name the
 * checklist does not name is rejected by multer, which matters on an endpoint that
 * is public and unauthenticated. `multer.any()` would have been simpler and is
 * deliberately not used.
 */
const registrationUpload: RequestHandler = (req, res, next) => {
  void checklistFor('APPLICATION')
    .then((items) => {
      const fields = items.flatMap((item) =>
        requiredSides(item.sides).map((side) => ({
          name: uploadFieldName(item.code, side),
          maxCount: 1,
        })),
      );

      upload.fields(fields)(req, res, next);
    })
    .catch(next);
};

/**
 * `/api/v1/auth` — both audiences (api-specification.md §M1).
 *
 * Middleware order on every route is the one architecture.md §4 fixes:
 * throttle → authenticate → authorize → validate → controller. Decryption has
 * already happened app-wide, which is why the throttles can key on `req.body`.
 *
 * Throttles are mounted per route, never inherited (api-conventions.md §9):
 *  - `login`  5 / 15 min per IP+identifier — credential stuffing
 *  - `otp`    3 / 15 min per identifier    — code and reset-link issuing
 *
 * `refresh` carries no authentication middleware on purpose. The refresh token
 * IS the credential, and requiring a live access token to obtain a new one would
 * make the endpoint useless precisely when it is needed — after the access token
 * expired. (`api-specification.md` marks the admin refresh/logout row `A`; that
 * applies to logout, which does need a session to identify the subject.)
 */
export const authRouter = Router();

// --- member ----------------------------------------------------------------

authRouter.post(
  '/signup',
  rateLimiters.otp,
  validateRequest({ body: signupSchema }),
  controller.signup,
);

authRouter.get('/captcha', controller.captcha);

authRouter.post('/register', rateLimiters.otp, registrationUpload, controller.register);

authRouter.post(
  '/set-initial-password',
  validateRequest({ body: setInitialPasswordSchema }),
  controller.setInitialPassword,
);

authRouter.post(
  '/verify-otp',
  rateLimiters.otp,
  validateRequest({ body: verifyOtpSchema }),
  controller.verifyOtp,
);

authRouter.post(
  '/resend-otp',
  rateLimiters.otp,
  validateRequest({ body: resendOtpSchema }),
  controller.resendOtp,
);

authRouter.post(
  '/login',
  rateLimiters.login,
  validateRequest({ body: loginSchema }),
  controller.login,
);

authRouter.post('/refresh', validateRequest({ body: refreshSchema }), controller.refresh);

authRouter.post(
  '/logout',
  authenticate,
  validateRequest({ body: logoutSchema }),
  controller.logout,
);

authRouter.post(
  '/forgot-password',
  rateLimiters.otp,
  validateRequest({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);

authRouter.post(
  '/reset-password',
  validateRequest({ body: resetPasswordSchema }),
  controller.resetPassword,
);

authRouter.post(
  '/change-password',
  authenticate,
  validateRequest({ body: changePasswordSchema }),
  controller.changePassword,
);

authRouter.get('/me', authenticate, controller.me);

// --- staff -----------------------------------------------------------------
//
// Mounted on the same router under `/admin` so the two audiences' auth surface
// is visible in one file — the thing most worth being able to read in one go.

authRouter.post(
  '/admin/login',
  rateLimiters.login,
  validateRequest({ body: adminLoginSchema }),
  controller.adminLogin,
);

authRouter.post(
  '/admin/refresh',
  validateRequest({ body: refreshSchema }),
  controller.adminRefresh,
);

authRouter.post(
  '/admin/logout',
  authenticateAdmin,
  validateRequest({ body: logoutSchema }),
  controller.adminLogout,
);

authRouter.get('/admin/me', authenticateAdmin, controller.adminMe);
