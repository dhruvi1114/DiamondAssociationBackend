import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import { XLSX_MIME } from '@helpers/excel';
import * as service from '@modules/report/report.service';
import type { GenerateReportInput, ListGeneratedQuery } from '@modules/report/report.types';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const actor = (req: Request) => {
  if (req.actor?.id === undefined) {
    throw new AppError({ errorType: ERROR_TYPES.UNAUTHORIZED, messageKey: 'auth.unauthorized' });
  }

  return {
    id: req.actor.id,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
};

/**
 * `POST /admin/reports` — run one now and keep the answer.
 *
 * The response is the saved row, not the rows themselves: the screen shows a
 * list of reports, and the data is fetched only when somebody opens or
 * downloads one.
 */
export const generateReport = handler(async (req, res) => {
  const result = await service.generateReport(req.body as GenerateReportInput, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'report.generated',
    data: result,
  });
});

/** `GET /admin/reports` — the reports anyone has generated, newest first. */
export const listReports = handler(async (req, res) => {
  const query = req.query as unknown as ListGeneratedQuery;
  const result = await service.listGeneratedReports(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: result.rows,
    pagination: { page: query.page, limit: query.limit, total: result.total },
  });
});

/** `GET /admin/reports/:id` — one report's stored figures, and its rows if kept. */
export const getReport = handler(async (req, res) => {
  const result = await service.getGeneratedReport(BigInt(req.params.id));

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});

/**
 * `GET /admin/reports/:id/export` — the saved report as an .xlsx.
 *
 * Rebuilt from the stored snapshot, never from a fresh query. That is what
 * makes the file the answer the report gave when it was run, which is the whole
 * reason reports are saved rather than recomputed.
 */
export const exportReport = handler(async (req, res) => {
  const { filename, buffer } = await service.buildReportFile(BigInt(req.params.id));

  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(buffer);
});
