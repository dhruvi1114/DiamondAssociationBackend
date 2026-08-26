import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { MSG_KEYS } from '@constant/message.constant';
import { AppError } from '@utils/appError';
import { translate } from '@utils/translate';

export interface ValidationSchemas {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

/**
 * zod validation for body, query and params (architecture.md §4).
 *
 * Runs AFTER `decryptPayload`, so `req.body` is already a plain object.
 * Failures collapse into one 422 with a flat `fields` map keyed by the client's
 * own field names — the shape `docs/api-conventions.md` §5 specifies and the
 * shape the frontends bind inline field errors to.
 *
 * Schemas put i18n keys in their zod messages (`'validation.invalidGst'`);
 * anything that is not a key passes through untranslated.
 */
export const validateRequest =
  (schemas: ValidationSchemas) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const fields: Record<string, string> = {};

    const run = <T>(schema: ZodSchema<T> | undefined, value: unknown, prefix: string) => {
      if (!schema) {
        return undefined;
      }

      const result = schema.safeParse(value);

      if (result.success) {
        return result.data;
      }

      for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join('.') : prefix;

        if (!fields[path]) {
          fields[path] = translate(res, issue.message);
        }
      }

      return undefined;
    };

    const body = run(schemas.body, req.body, 'body');
    const query = run(schemas.query, req.query, 'query');
    const params = run(schemas.params, req.params, 'params');

    if (Object.keys(fields).length > 0) {
      throw new AppError({
        errorType: ERROR_TYPES.VALIDATION_ERROR,
        messageKey: MSG_KEYS.VALIDATION_FAILED,
        details: { fields },
      });
    }

    if (schemas.body) {
      req.body = body;
    }

    if (schemas.query) {
      // Express 4 allows req.query to be reassigned; Express 5 does not, which
      // is one of the reasons ADR-014 keeps us on Express 4 for the MVP.
      Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true });
    }

    if (schemas.params) {
      req.params = params as Request['params'];
    }

    next();
  };
