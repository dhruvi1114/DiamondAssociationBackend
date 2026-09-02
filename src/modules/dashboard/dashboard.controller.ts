import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/dashboard/dashboard.service';
import { handleApiResponse } from '@utils/handleResponse';

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

/**
 * `GET /admin/dashboard/summary` — the counts behind the work queue.
 *
 * The response carries only the tiles this admin may act on, so the screen
 * renders what it is given rather than deciding for itself what to hide. A
 * permission check that lives in one place cannot drift from the one that
 * gates the underlying screens.
 */
export const getSummary = handler(async (req, res) => {
  const result = await service.getSummary(
    req.actor?.permissions ?? [],
    Boolean(req.actor?.isSuperAdmin),
  );

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});
