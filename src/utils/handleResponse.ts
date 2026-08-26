import type { Response } from 'express';
import { environment } from '@config/config';
import {
  MSG_KEYS,
  RES_STATUS,
  RES_STATUS_MESSAGE_KEYS,
  type ResponseStatus,
} from '@constant/message.constant';
import { encrypt } from '@helpers/encryption';
import { isEncryptionBypassed } from '@middleware/decryption';
import { translate } from '@utils/translate';

export interface PaginationInput {
  page: number;
  limit: number;
  total: number;
}

export interface PaginationMeta extends PaginationInput {
  totalPages: number;
}

export interface ApiResponseOptions<T> {
  statusCode?: number;
  responseType?: ResponseStatus;
  /** i18n key — `MSG_KEYS.*` or a module key such as `'application.submitted'`. */
  messageKey?: string;
  /** Mustache values for the message. */
  replacements?: Record<string, string>;
  data?: T;
  pagination?: PaginationInput;
}

export interface ErrorResponseOptions {
  statusCode: number;
  message: string;
  code: string;
  error?: unknown;
  requestId?: string;
}

const DEFAULT_STATUS_CODES: Record<ResponseStatus, number> = {
  [RES_STATUS.CREATE]: 201,
  [RES_STATUS.GET]: 200,
  [RES_STATUS.UPDATE]: 200,
  [RES_STATUS.DELETE]: 200,
  [RES_STATUS.ACTION]: 200,
};

const buildPagination = (pagination: PaginationInput): PaginationMeta => ({
  page: pagination.page,
  limit: pagination.limit,
  total: pagination.total,
  totalPages: pagination.limit > 0 ? Math.ceil(pagination.total / pagination.limit) : 0,
});

/**
 * The success envelope (api-conventions.md §2/§4).
 *
 *   { success, statusCode, message, data: "<ciphertext>", pagination }
 *
 * `success`, `statusCode`, `message` and `pagination` stay plaintext so nginx,
 * uptime monitors and log pipelines can read them without a key. Only `data`
 * is encrypted.
 *
 * `decrypted_data` is added **only** when APP_ENV === 'local' — never in dev,
 * staging or production (security.md §4.5, asserted by Sentinel).
 */
export const handleApiResponse = <T>(res: Response, options: ApiResponseOptions<T>): Response => {
  const {
    statusCode,
    responseType = RES_STATUS.GET,
    messageKey,
    replacements,
    data,
    pagination,
  } = options;

  const httpStatusCode = statusCode ?? DEFAULT_STATUS_CODES[responseType];
  const key = messageKey ?? RES_STATUS_MESSAGE_KEYS[responseType];

  const body: Record<string, unknown> = {
    success: true,
    statusCode: httpStatusCode,
    message: translate(res, key, replacements),
  };

  if (data !== undefined) {
    body.data = isEncryptionBypassed(res.req) ? data : encrypt(data);
  }

  if (pagination) {
    body.pagination = buildPagination(pagination);
  }

  if (environment.isLocal && data !== undefined && !isEncryptionBypassed(res.req)) {
    body.decrypted_data = data;
  }

  return res.status(httpStatusCode).json(body);
};

/**
 * The error envelope (api-conventions.md §5). `message` is already translated
 * by `ErrorHandler`; `requestId` is echoed so a user can quote it in a support
 * message (observability.md §2).
 */
export const handleErrorResponse = (res: Response, options: ErrorResponseOptions): Response => {
  const { statusCode, message, code, error, requestId } = options;

  const body: Record<string, unknown> = {
    success: false,
    statusCode,
    message,
    code,
  };

  if (error !== undefined) {
    body.error = error;
  }

  if (requestId) {
    body.requestId = requestId;
  }

  return res.status(statusCode).json(body);
};

/** Re-exported so controllers can name the generic success key without an import dance. */
export { MSG_KEYS };
