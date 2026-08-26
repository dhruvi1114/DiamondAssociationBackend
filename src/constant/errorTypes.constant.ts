/**
 * The error code table from `docs/api-conventions.md` §5 — the single source of
 * truth for both the `code` field returned to clients and the HTTP status.
 * Adding a code here without adding it to `ERROR_STATUS_CODES` is a type error.
 */
export const ERROR_TYPES = {
  /** zod rejected the payload. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Malformed or undecryptable request. */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** Missing, expired or invalid token. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Authenticated but lacks the permission, or wrong token audience. */
  FORBIDDEN: 'FORBIDDEN',
  /** Absent, or deliberately invisible to this actor (never 403 for member data). */
  NOT_FOUND: 'NOT_FOUND',
  /** Uniqueness / duplicate / concurrent-state clash. */
  CONFLICT: 'CONFLICT',
  /** A workflow guard rejected the move. */
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  /** Payment gateway declined. */
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  /** Throttled. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Anything unexpected — logged with a stack, never returned with one. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES];

export const ERROR_STATUS_CODES: Record<ErrorType, number> = {
  [ERROR_TYPES.VALIDATION_ERROR]: 422,
  [ERROR_TYPES.INVALID_REQUEST]: 400,
  [ERROR_TYPES.UNAUTHORIZED]: 401,
  [ERROR_TYPES.FORBIDDEN]: 403,
  [ERROR_TYPES.NOT_FOUND]: 404,
  [ERROR_TYPES.CONFLICT]: 409,
  [ERROR_TYPES.INVALID_STATE_TRANSITION]: 409,
  [ERROR_TYPES.PAYMENT_FAILED]: 402,
  [ERROR_TYPES.RATE_LIMITED]: 429,
  [ERROR_TYPES.INTERNAL_ERROR]: 500,
};

/** Default i18n message key per error type, used when a thrower supplies none. */
export const ERROR_MESSAGE_KEYS: Record<ErrorType, string> = {
  [ERROR_TYPES.VALIDATION_ERROR]: 'validation.failed',
  [ERROR_TYPES.INVALID_REQUEST]: 'common.invalidRequest',
  [ERROR_TYPES.UNAUTHORIZED]: 'auth.unauthorized',
  [ERROR_TYPES.FORBIDDEN]: 'rbac.forbidden',
  [ERROR_TYPES.NOT_FOUND]: 'common.notFound',
  [ERROR_TYPES.CONFLICT]: 'common.conflict',
  [ERROR_TYPES.INVALID_STATE_TRANSITION]: 'common.invalidStateTransition',
  [ERROR_TYPES.PAYMENT_FAILED]: 'payment.failed',
  [ERROR_TYPES.RATE_LIMITED]: 'common.rateLimited',
  [ERROR_TYPES.INTERNAL_ERROR]: 'common.internalError',
};
