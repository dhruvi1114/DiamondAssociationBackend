import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from '@logger/requestContext';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_CLIENT_REQUEST_ID_LENGTH = 64;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Establishes the correlation id for this request (observability.md §2).
 *
 * A client-supplied `x-request-id` is honoured so a browser trace and a server
 * trace line up, but only after validation: the id is echoed in responses and
 * written to logs, so an unvalidated one is a log-injection and header-injection
 * vector. Anything unexpected is replaced with a generated uuid.
 */
export const requestContext = (req: Request, res: Response, next: NextFunction): void => {
  const supplied = req.get(REQUEST_ID_HEADER);

  const requestId =
    supplied && supplied.length <= MAX_CLIENT_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(supplied)
      ? supplied
      : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext({ requestId }, () => {
    next();
  });
};
