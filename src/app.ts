import express from 'express';
import type { Express, Request, Response } from 'express';
import { END_POINTS } from '@constant';
import {
  decryptPayload,
  ErrorHandler,
  i18nHandler,
  notFoundHandler,
  registerSecurityMiddlewares,
  requestContext,
  responseHandler,
} from '@middleware';
import { router as rootRouter } from '@routes/index';

const JSON_BODY_LIMIT = '1mb';

/**
 * Request lifecycle (architecture.md §4). Order is load-bearing:
 *
 *   requestContext   correlation id first, so every later line can carry it
 *   security         helmet / CORS / global rate limit — cheap rejections early
 *   express.json     with `verify` capturing rawBody (ADR-018)
 *   decryptPayload   ciphertext → object, before anything reads the body
 *   i18nHandler      `lan` header → locale, before any message is resolved
 *   responseHandler  starts the latency clock
 *   router           authenticate → authorize → validate → controller
 *   notFoundHandler  unmatched path, same envelope as any other error
 *   ErrorHandler     the single exit for every failure
 */
export const createApp = (): Express => {
  const app = express();

  app.use(requestContext);

  registerSecurityMiddlewares(app);

  app.use(
    express.json({
      limit: JSON_BODY_LIMIT,
      // Gateway webhook signatures are computed over the exact bytes, which
      // express.json() otherwise discards. Capturing it from M0 means M5 does
      // not have to reopen the frozen shared core (ADR-018).
      verify: (req: Request, _res: Response, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

  app.use(decryptPayload);
  app.use(i18nHandler);
  app.use(responseHandler);

  app.use(END_POINTS.COMMON, rootRouter);

  app.use(notFoundHandler);
  app.use(ErrorHandler);

  return app;
};
