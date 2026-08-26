import { Router } from 'express';
import multer from 'multer';
import { END_POINTS } from '@constant';
import {
  authenticateAdmin,
  authorize,
  rateLimiters,
  requireSuperAdmin,
  validateRequest,
} from '@middleware';
import * as controller from '@modules/application/public.controller';
import {
  applicationIdParamSchema,
  correctApplicationSchema,
  documentTokenParamSchema,
  reopenApplicationSchema,
  resendLinkSchema,
  resetResubmissionsSchema,
  tokenParamSchema,
} from '@modules/application/public.types';

/**
 * `/api/v1/public/applications/…` — the applicant's way back in (spec D-9).
 *
 * Everything here is unauthenticated by design, which makes the middleware
 * order the security control rather than a formality:
 *
 *   throttle → validate the token's SHAPE → resolve it to one application
 *
 * The throttle comes first so a spray of malformed links costs the attacker
 * their budget before it costs us a database round trip. Validation comes next
 * so nothing outside `[A-Za-z0-9_-]{20,200}` is ever hashed. Only then does the
 * service turn the secret into an application id — and that id comes from the
 * token row, never from the request, which is what keeps one link scoped to one
 * application and nothing else.
 *
 * Uploads use the same memory-backed multer configuration as registration and
 * member KYC: bytes are sniffed before anything touches disk (file-storage.md
 * §3), and one file per request.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

export const applicationPublicRouter = Router();

/**
 * "I lost the email." Throttled per ADDRESS, not per IP — `rateLimiters.otp`
 * keys on `req.body.email`, which is the right key for something that emails a
 * person: three a quarter hour stops an inbox being used as a weapon while
 * leaving a genuinely confused applicant room to try twice.
 *
 * Declared before the `:token` routes so the intent reads top-down; Express
 * would not confuse them in any case, since no `:token` route answers a POST at
 * this depth.
 */
applicationPublicRouter.post(
  `${END_POINTS.APPLICATIONS}/resend-link`,
  rateLimiters.otp,
  validateRequest({ body: resendLinkSchema }),
  controller.resendLink,
);

applicationPublicRouter.get(
  `${END_POINTS.APPLICATIONS}/:token`,
  rateLimiters.resubmitLink,
  validateRequest({ params: tokenParamSchema }),
  controller.getApplication,
);

applicationPublicRouter.patch(
  `${END_POINTS.APPLICATIONS}/:token`,
  rateLimiters.resubmitLink,
  validateRequest({ params: tokenParamSchema, body: correctApplicationSchema }),
  controller.correctApplication,
);

// Multipart, so it is on the decryption bypass list (api-conventions.md §2).
// The document type is in the PATH rather than the body: a replacement is
// addressed at the requirement it satisfies, and a code that is not one of the
// three fixed constants is a 422 from the param schema before multer runs.
applicationPublicRouter.post(
  `${END_POINTS.APPLICATIONS}/:token/documents/:documentTypeCode`,
  rateLimiters.resubmitLink,
  validateRequest({ params: documentTokenParamSchema }),
  upload.single('file'),
  controller.replaceDocument,
);

applicationPublicRouter.post(
  `${END_POINTS.APPLICATIONS}/:token/submit`,
  rateLimiters.resubmitLink,
  validateRequest({ params: tokenParamSchema }),
  controller.resubmit,
);

/**
 * `/api/v1/admin/applications/:id/resubmissions/reset` — spec D-13.
 *
 * A second admin router rather than a line in `application.routes.ts`, because
 * this endpoint belongs to the reject-resubmit flow rather than to the reviewer
 * queue: it is the only thing in that flow a reviewer may NOT do.
 *
 * Guarded by `settings.manage` **and** `requireSuperAdmin`, the pairing
 * `settings.routes.ts` uses. The cap being reset is a system setting
 * (`application.max_resubmissions`), so overriding it for one application is the
 * same authority as changing it for all of them — and the permission states the
 * intent in the RBAC matrix while the super-admin floor survives someone
 * granting that permission to another role.
 */
export const applicationSuperAdminRouter = Router();

applicationSuperAdminRouter.post(
  `${END_POINTS.APPLICATIONS}/:id/resubmissions/reset`,
  authenticateAdmin,
  authorize('settings.manage'),
  requireSuperAdmin,
  validateRequest({ params: applicationIdParamSchema, body: resetResubmissionsSchema }),
  controller.resetResubmissions,
);

/**
 * Reopen a closed application — spec D-18.
 *
 * Same guard as the reset above, because it is the same authority: both override
 * `application.max_resubmissions` for one applicant, and the difference between
 * them is only how far the application had already travelled.
 *
 * Two routes rather than one flag, so each is unambiguous from the outside. The
 * application's status decides which applies — `RETURNED_FOR_CORRECTION` takes
 * the reset, `REJECTED` takes the reopen — and each refuses the other's case by
 * naming it, so an admin who picks wrongly is told where to go rather than
 * quietly getting the wrong outcome. Reopen is the heavier of the two: it
 * reverses a decision the applicant has already been told about, issues a new
 * link and sends an email, none of which the reset does.
 */
applicationSuperAdminRouter.post(
  `${END_POINTS.APPLICATIONS}/:id/reopen`,
  authenticateAdmin,
  authorize('settings.manage'),
  requireSuperAdmin,
  validateRequest({ params: applicationIdParamSchema, body: reopenApplicationSchema }),
  controller.reopenApplication,
);
