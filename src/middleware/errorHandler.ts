import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { environment } from '@config/config';
import { ERROR_STATUS_CODES, ERROR_TYPES, type ErrorType } from '@constant/errorTypes.constant';
import { MSG_KEYS } from '@constant/message.constant';
import { logger } from '@logger/logger';
import { AppError } from '@utils/appError';
import { handleErrorResponse } from '@utils/handleResponse';
import { translate } from '@utils/translate';

interface NormalisedError {
  errorType: ErrorType;
  messageKey: string;
  replacements?: Record<string, string>;
  code: string;
  /** Client-safe detail only. Nothing here may describe the schema or the query. */
  details?: unknown;
  /** Logged, never returned. */
  internal?: unknown;
}

/** Body-parser failures arrive as plain Errors carrying a `type` discriminator. */
interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

const zodFieldMessages = (error: ZodError, res: Response): Record<string, string> => {
  const fields: Record<string, string> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';

    if (!fields[path]) {
      // Schemas carry i18n keys as their zod message; anything that is not a
      // known key falls through unchanged so a stock zod message still reads well.
      fields[path] = translate(res, issue.message);
    }
  }

  return fields;
};

/**
 * Translate the i18n keys a service put inside `details.fields`.
 *
 * A service throwing an AppError has no `res`, so it names the field's message
 * by key — `{ fields: { gst_number: 'member.gstAlreadyRegistered' } }` — and the
 * translation happens here, where the request's locale is known. Anything that
 * is not a known key falls through unchanged, exactly as `zodFieldMessages`
 * does, so a literal sentence still reads well.
 *
 * Without this the client renders the raw key under the input.
 */
const localiseDetails = (details: unknown, res: Response): unknown => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return details;

  const record = details as Record<string, unknown>;
  const fields = record.fields;

  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return details;

  const localised: Record<string, unknown> = {};

  for (const [field, message] of Object.entries(fields as Record<string, unknown>)) {
    localised[field] = typeof message === 'string' ? translate(res, message) : message;
  }

  return { ...record, fields: localised };
};

const normalise = (error: unknown, res: Response): NormalisedError => {
  if (error instanceof AppError) {
    return {
      errorType: error.errorType,
      messageKey: error.messageKey,
      replacements: error.replacements,
      code: error.code,
      details: error.details,
      internal: { sourcePath: error.sourcePath, cause: error.cause },
    };
  }

  if (error instanceof ZodError) {
    return {
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: MSG_KEYS.VALIDATION_FAILED,
      code: ERROR_TYPES.VALIDATION_ERROR,
      details: { fields: zodFieldMessages(error, res) },
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Prisma error metadata names tables and columns. Logged, never sent.
    const internal = { prismaCode: error.code, meta: error.meta };

    switch (error.code) {
      case 'P2002':
        return {
          errorType: ERROR_TYPES.CONFLICT,
          messageKey: MSG_KEYS.CONFLICT,
          code: ERROR_TYPES.CONFLICT,
          internal,
        };
      case 'P2003':
      case 'P2025':
        return {
          errorType: ERROR_TYPES.NOT_FOUND,
          messageKey: MSG_KEYS.NOT_FOUND,
          code: ERROR_TYPES.NOT_FOUND,
          internal,
        };
      default:
        return {
          errorType: ERROR_TYPES.INTERNAL_ERROR,
          messageKey: MSG_KEYS.INTERNAL_ERROR,
          code: ERROR_TYPES.INTERNAL_ERROR,
          internal,
        };
    }
  }

  if (
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return {
      errorType: ERROR_TYPES.INTERNAL_ERROR,
      messageKey: MSG_KEYS.INTERNAL_ERROR,
      code: ERROR_TYPES.INTERNAL_ERROR,
      internal: { name: error.name, detail: error.message },
    };
  }

  const bodyParserError = error as BodyParserError;

  if (bodyParserError?.type === 'entity.too.large') {
    return {
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'validation.payloadTooLarge',
      code: ERROR_TYPES.VALIDATION_ERROR,
    };
  }

  if (bodyParserError?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return {
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: MSG_KEYS.INVALID_REQUEST,
      code: ERROR_TYPES.INVALID_REQUEST,
    };
  }

  return {
    errorType: ERROR_TYPES.INTERNAL_ERROR,
    messageKey: MSG_KEYS.INTERNAL_ERROR,
    code: ERROR_TYPES.INTERNAL_ERROR,
    internal: error,
  };
};

/**
 * The single exit for every failure (api-conventions.md §5).
 *
 * Guarantees, in order of importance:
 *  1. Never leaks a stack trace, SQL, a Prisma message or a table name.
 *  2. Always emits the documented `code` from the §5 table.
 *  3. Always echoes `requestId` so a user can quote it to support.
 *  4. Always logs the full internal detail at `error` (5xx) or `warn` (4xx).
 */
export const ErrorHandler: ErrorRequestHandler = (err, req: Request, res: Response, _next) => {
  const normalised = normalise(err, res);
  const statusCode = ERROR_STATUS_CODES[normalised.errorType];
  const message = translate(res, normalised.messageKey, normalised.replacements);

  const logMeta = {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    status: statusCode,
    errorCode: normalised.code,
    messageKey: normalised.messageKey,
    internal: normalised.internal,
    stack: err instanceof Error ? err.stack : undefined,
  };

  if (statusCode >= 500) {
    logger.error('request.failed', logMeta);
  } else {
    logger.warn('request.rejected', logMeta);
  }

  if (!res.headersSent) {
    // Read back by `responseHandler` for the completion log line.
    res.setHeader('x-error-code', normalised.code);
  }

  return handleErrorResponse(res, {
    statusCode,
    message,
    code: normalised.code,
    error: localiseDetails(normalised.details, res),
    requestId: req.requestId,
  });
};

/** 404 for an unmounted path, in the same envelope as every other error. */
export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(
    new AppError({
      errorType: ERROR_TYPES.NOT_FOUND,
      messageKey: MSG_KEYS.ROUTE_NOT_FOUND,
      sourcePath: `${req.method} ${req.originalUrl}`,
    }),
  );
};

/**
 * Process-level crash handling (observability.md §6).
 *
 * An uncaught exception leaves the process in an unknown state, so the only
 * safe response is: log it, try to notify, exit, let the supervisor restart.
 * `onFatal` is injected by `index.ts` so this module does not depend on the
 * notification stack — which is itself a thing that can throw.
 *
 * SIGTERM/SIGINT are NOT handled here: `index.ts` owns graceful shutdown,
 * because draining the HTTP server and stopping the cron tasks needs handles
 * this module has no business knowing about.
 */
export const GlobalErrorHandler = (
  onFatal?: (context: string, error: unknown) => Promise<void>,
): void => {
  process.on('uncaughtException', (error) => {
    logger.error('process.uncaughtException', {
      name: error.name,
      detail: error.message,
      stack: error.stack,
    });

    void Promise.resolve(onFatal?.('uncaughtException', error))
      .catch(() => undefined)
      .finally(() => {
        process.exit(1);
      });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandledRejection', {
      detail: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });

    void Promise.resolve(onFatal?.('unhandledRejection', reason)).catch(() => undefined);
  });

  if (environment.isLocal) {
    logger.debug('process.handlersRegistered');
  }
};
