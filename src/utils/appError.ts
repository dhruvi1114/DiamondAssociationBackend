import type { ErrorType } from '@constant/errorTypes.constant';
import { ERROR_MESSAGE_KEYS, ERROR_STATUS_CODES, ERROR_TYPES } from '@constant/errorTypes.constant';

export interface AppErrorParams {
  /** Drives both the HTTP status and the `code` returned to the client. */
  errorType?: ErrorType;
  /**
   * i18n key in `<namespace>.<key>` form (e.g. `application.notEditable`).
   * Resolved against the caller's `lan` header by `ErrorHandler`. Defaults to
   * the message key registered for `errorType`.
   */
  messageKey?: string;
  /** Mustache values for the message, e.g. `{ minutes: '15' }`. */
  replacements?: Record<string, string>;
  /**
   * Client-safe `code` override. Defaults to `errorType`, which is already the
   * api-conventions.md §5 table, so this is rarely needed.
   */
  code?: string;
  /**
   * Client-safe structured detail — e.g. `{ fields: { gst_number: '…' } }`.
   * Must never contain SQL, stack traces, table names or internal ids.
   */
  details?: unknown;
  /** Internal breadcrumb for the log line only. Never serialised to a client. */
  sourcePath?: string;
  /** Original error, logged with its stack. Never serialised to a client. */
  cause?: unknown;
}

/**
 * The only error type services and controllers may throw for expected failures.
 *
 * It carries an i18n **key**, not a rendered string, so the same throw produces
 * the right language for whichever client raised it.
 */
export class AppError extends Error {
  public readonly errorType: ErrorType;

  public readonly statusCode: number;

  public readonly messageKey: string;

  public readonly replacements?: Record<string, string>;

  public readonly code: string;

  public readonly details?: unknown;

  public readonly sourcePath?: string;

  public readonly cause?: unknown;

  constructor({
    errorType = ERROR_TYPES.INTERNAL_ERROR,
    messageKey,
    replacements,
    code,
    details,
    sourcePath,
    cause,
  }: AppErrorParams) {
    const resolvedKey = messageKey ?? ERROR_MESSAGE_KEYS[errorType];

    // `message` stays the key: it is what shows up in logs and stack traces,
    // where a translated sentence would be noise.
    super(resolvedKey);

    this.name = 'AppError';
    this.errorType = errorType;
    this.statusCode = ERROR_STATUS_CODES[errorType];
    this.messageKey = resolvedKey;
    this.replacements = replacements;
    this.code = code ?? errorType;
    this.details = details;
    this.sourcePath = sourcePath;
    this.cause = cause;

    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** Convenience constructors for the codes thrown most often. */
export const notFound = (messageKey?: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey });

export const forbidden = (messageKey?: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.FORBIDDEN, messageKey });

export const unauthorized = (messageKey?: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey });

export const conflict = (messageKey?: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.CONFLICT, messageKey });

export const invalidRequest = (messageKey?: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.INVALID_REQUEST, messageKey });

export const invalidStateTransition = (messageKey?: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.INVALID_STATE_TRANSITION, messageKey });
