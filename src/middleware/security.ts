import type { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';
import { environment } from '@config/config';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { MSG_KEYS } from '@constant/message.constant';
import { logger } from '@logger/logger';
import { AppError } from '@utils/appError';

/**
 * Every limiter answers a 429 through the normal error pipeline so the client
 * sees the same envelope and `code` as any other failure (api-conventions §5).
 */
const rateLimitHandler = (_req: Request, _res: Response, next: (error: unknown) => void): void => {
  next(
    new AppError({
      errorType: ERROR_TYPES.RATE_LIMITED,
      messageKey: MSG_KEYS.RATE_LIMITED,
    }),
  );
};

const baseLimiterOptions: Partial<RateLimitOptions> = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
};

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

/**
 * Named limiters from `docs/api-conventions.md` §9. Exported rather than
 * applied globally so each route mounts exactly the one it needs; a login
 * route that inherits only the global cap is effectively unthrottled.
 *
 * Known limitation (OQ-14, security.md §6): the default store is in-memory, so
 * counters reset on restart and do not span instances. Acceptable for a
 * single-instance MVP, NOT acceptable once a second instance exists.
 */
export const rateLimiters = {
  /** 300 requests / 15 min per IP. */
  global: rateLimit({
    ...baseLimiterOptions,
    windowMs: environment.rateLimitWindowMs,
    limit: environment.rateLimitMax,
  }),

  /**
   * 5 FAILED sign-ins / 15 min per IP + identifier — credential-stuffing defence.
   *
   * `skipSuccessfulRequests` matters more than it looks. Counting successful
   * logins too meant a legitimate account had a budget of five sign-ins per
   * quarter hour: a developer, a user on three devices, or the self-test harness
   * would exhaust it and then be told they were rate limited while holding the
   * correct password. It also weakened the signal — the thing worth counting for
   * credential stuffing is failures.
   *
   * Account lockout (auth.service `registerFailure`) is the per-account half of
   * this defence and is unchanged: five failures still lock the account for
   * fifteen minutes regardless of which IP they came from.
   */
  login: rateLimit({
    ...baseLimiterOptions,
    windowMs: FIFTEEN_MINUTES,
    limit: 5,
    skipSuccessfulRequests: true,
    keyGenerator: (req: Request) => {
      const identifier =
        typeof (req.body as { email?: unknown })?.email === 'string'
          ? (req.body as { email: string }).email.toLowerCase()
          : 'anonymous';

      return `${req.ip}:${identifier}`;
    },
  }),

  /** 3 / 15 min per identifier — OTP issue and forgot-password. */
  otp: rateLimit({
    ...baseLimiterOptions,
    windowMs: FIFTEEN_MINUTES,
    limit: 3,
    keyGenerator: (req: Request) => {
      const body = req.body as { email?: unknown; identifier?: unknown; phone?: unknown };
      const identifier = [body?.identifier, body?.email, body?.phone].find(
        (value) => typeof value === 'string' && value.length > 0,
      );

      return typeof identifier === 'string' ? identifier.toLowerCase() : String(req.ip);
    },
  }),

  /** 60 / min per IP — unauthenticated directory and public search. */
  publicSearch: rateLimit({
    ...baseLimiterOptions,
    windowMs: ONE_MINUTE,
    limit: 60,
  }),

  /**
   * 40 / 15 min per IP — the login-free resubmit link (reject-resubmit spec §6.6).
   *
   * Tighter than `publicSearch` because these requests WRITE. The token itself
   * carries 256 bits, so this is not what stops a guess — nothing reachable at
   * one attempt per second gets near a 2^256 space. What it stops is the cheap
   * abuse an unauthenticated write endpoint actually attracts: someone spraying
   * candidate links to see which shape of error comes back, and someone pushing
   * 50 MB uploads at a route that has no account to suspend.
   *
   * The budget is deliberately generous for a real applicant. Correcting two
   * documents and a field is a handful of requests, and being throttled halfway
   * through a correction is how a returned application becomes a phone call.
   */
  resubmitLink: rateLimit({
    ...baseLimiterOptions,
    windowMs: FIFTEEN_MINUTES,
    limit: 40,
  }),
};

/**
 * helmet + CORS + the global rate limit (security.md §5).
 *
 * CORS is an explicit origin allowlist from `CORS_ORIGINS`; `*` is rejected by
 * the config loader, and requests with no `Origin` (server-to-server, curl,
 * uptime monitors) are allowed because CORS is a browser control and blocking
 * them would break health checks without adding security.
 */
export const registerSecurityMiddlewares = (app: Express): void => {
  // Real client IP behind nginx — rate limiting and IP audit are wrong without it.
  app.set('trust proxy', environment.trustProxyHops);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and streamed attachments, never HTML, so the
      // frontends' own CSP governs pages. Here we only need the header set
      // that stops content sniffing and framing of any error page.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: environment.isLocal ? false : { maxAge: 31_536_000, includeSubDomains: true },
    }),
  );

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || environment.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        logger.warn('cors.rejected', { origin });
        callback(
          new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey: 'rbac.forbidden' }),
          false,
        );
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'lan', 'x-request-id'],
      // `Content-Disposition` so a browser download can read the filename the
      // server chose, rather than the UI guessing one from the URL.
      exposedHeaders: ['x-request-id', 'Content-Disposition'],
      maxAge: 600,
    }),
  );

  app.use(rateLimiters.global);
};
