import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/audit/audit.service';
import { handleApiResponse } from '@utils/handleResponse';

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

export const listAuditLogs = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listAuditLogs>[0];
  const result = await service.listAuditLogs(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: result.rows,
    pagination: { page: query.page, limit: query.limit, total: result.total },
  });
});

export const listFacets = handler(async (_req, res) => {
  const result = await service.listFacets();

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});
