/**
 * Response classification used by `handleApiResponse` to pick a default HTTP
 * status when a controller does not state one (api-conventions.md §4).
 */
export const RES_STATUS = {
  CREATE: 'CREATE',
  GET: 'GET',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  ACTION: 'ACTION',
} as const;

export type ResponseStatus = (typeof RES_STATUS)[keyof typeof RES_STATUS];

/**
 * i18n message keys for the cross-cutting cases the shared core itself emits.
 *
 * Rule (architecture.md §6): controllers and services pass a **key**, never a
 * literal. `handleApiResponse` and `ErrorHandler` resolve it against the
 * caller's `lan` header. Module-specific keys live in `src/locales/en.json`
 * under that module's namespace and are referenced by string from the module.
 */
export const MSG_KEYS = {
  SUCCESS: 'common.success',
  CREATED: 'common.created',
  UPDATED: 'common.updated',
  DELETED: 'common.deleted',
  FETCHED: 'common.fetched',
  NO_DATA: 'common.noData',
  NOT_FOUND: 'common.notFound',
  CONFLICT: 'common.conflict',
  INVALID_REQUEST: 'common.invalidRequest',
  INTERNAL_ERROR: 'common.internalError',
  RATE_LIMITED: 'common.rateLimited',
  ROUTE_NOT_FOUND: 'common.routeNotFound',
  HEALTHY: 'common.healthy',
  NOT_READY: 'common.notReady',
  VALIDATION_FAILED: 'validation.failed',
  UNAUTHORIZED: 'auth.unauthorized',
  FORBIDDEN: 'rbac.forbidden',
} as const;

export type MessageKey = (typeof MSG_KEYS)[keyof typeof MSG_KEYS];

/** Default message key per response classification. */
export const RES_STATUS_MESSAGE_KEYS: Record<ResponseStatus, string> = {
  [RES_STATUS.CREATE]: MSG_KEYS.CREATED,
  [RES_STATUS.GET]: MSG_KEYS.FETCHED,
  [RES_STATUS.UPDATE]: MSG_KEYS.UPDATED,
  [RES_STATUS.DELETE]: MSG_KEYS.DELETED,
  [RES_STATUS.ACTION]: MSG_KEYS.SUCCESS,
};
