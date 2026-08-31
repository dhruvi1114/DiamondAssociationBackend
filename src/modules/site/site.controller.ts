import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/site/site.service';
import { handleApiResponse } from '@utils/handleResponse';

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

export const siteStats = handler(async (_req, res) => {
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: await service.getSiteStats() });
});
