import { createLogger, format, transports } from 'winston';
import { environment } from '@config/config';
import { getRequestContext } from '@logger/requestContext';
import { isRedactedKey, redact } from '@logger/redact';

/**
 * JSON-lines logger (observability.md §2).
 *
 *   {"ts":"…","level":"info","env":"local","requestId":"…","actorType":"ADMIN",
 *    "actorId":"42","method":"POST","url":"…","status":200,"durationMs":184}
 *
 * Two formatters do the important work:
 *  - `injectContext` stamps the in-flight requestId/actor onto every line, so a
 *    log written deep inside a service is still correlatable.
 *  - `redactSecrets` recursively masks the denylist (§3) BEFORE serialisation.
 *    It mutates `info` in place rather than returning a fresh object, because
 *    winston carries the level on a Symbol key that a clone would drop.
 *
 * Transport is stdout only. Rotation and 14-day retention are the host's job
 * (pm2-logrotate / logrotate, observability.md §7) — an in-process file rotator
 * would compete with them for the same files.
 */

const RESERVED_KEYS = new Set(['level', 'message', 'ts', 'env', 'stack']);

const injectContext = format((info) => {
  const context = getRequestContext();

  if (context) {
    info.requestId = info.requestId ?? context.requestId;
    info.actorType = info.actorType ?? context.actorType;
    info.actorId = info.actorId ?? context.actorId;
  }

  info.ts = new Date().toISOString();
  info.env = environment.appEnv;

  return info;
});

const redactSecrets = format((info) => {
  const record = info as unknown as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (RESERVED_KEYS.has(key)) {
      continue;
    }

    record[key] = isRedactedKey(key) ? '[REDACTED]' : redact(record[key]);
  }

  return info;
});

export const logger = createLogger({
  level: environment.logLevel,
  format: format.combine(
    format.errors({ stack: true }),
    injectContext(),
    redactSecrets(),
    format.json(),
  ),
  transports: [new transports.Console({ handleExceptions: false, handleRejections: false })],
  exitOnError: false,
});

/**
 * Structured helper so callers stop hand-building message strings.
 * `meta` goes through the same redaction pass as everything else.
 */
export const log = {
  error: (message: string, meta?: Record<string, unknown>) => logger.error(message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => logger.warn(message, meta),
  info: (message: string, meta?: Record<string, unknown>) => logger.info(message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => logger.debug(message, meta),
};
