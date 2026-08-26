import type { NextFunction, Request, Response } from 'express';
import { environment } from '@config/config';
import { logger } from '@logger/logger';

/**
 * One structured log line per completed request (observability.md §4).
 *
 * Logged: method, url, status, latency, response size, actor, requestId, and
 * for 4xx/5xx the error `code`.
 * Never logged: any body, header or query value — the payload of an auth or
 * payment endpoint is exactly what §3 forbids.
 *
 * Requests slower than SLOW_REQUEST_MS log at `warn` with the route, so an N+1
 * regression surfaces in the log stream instead of needing a profiler.
 */
export const responseHandler = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const rounded = Math.round(durationMs);

    const meta: Record<string, unknown> = {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: rounded,
      responseBytes: Number(res.getHeader('content-length') ?? 0),
      ip: req.ip,
      actorType: req.actor?.type,
      actorId: req.actor?.id?.toString(),
    };

    const errorCode = res.getHeader('x-error-code');

    if (errorCode) {
      meta.errorCode = String(errorCode);
    }

    if (res.statusCode >= 500) {
      logger.error('request.completed', meta);
    } else if (rounded > environment.slowRequestMs) {
      logger.warn('request.slow', meta);
    } else if (res.statusCode >= 400) {
      logger.warn('request.completed', meta);
    } else {
      logger.info('request.completed', meta);
    }
  });

  next();
};
