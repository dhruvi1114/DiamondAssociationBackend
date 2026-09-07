import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RES_STATUS } from '@constant/message.constant';
import type { DashboardFilters } from '@modules/dashboard/dashboard.filters';
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

/**
 * `GET /admin/dashboard/kpis` — the headline figures for a period.
 *
 * Separate from `/summary` deliberately: the work-queue counts are cheap and
 * change by the minute, while these are heavier and change by the week. Two
 * endpoints means the queue cards paint immediately instead of waiting on a
 * twelve-month aggregate.
 */
export const getKpis = handler(async (req, res) => {
  const result = await service.getKpis(req.query as unknown as DashboardFilters);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});

/**
 * `GET /admin/dashboard/charts` — the series behind the graphs.
 *
 * Its own endpoint, and the slowest of the three. Splitting it from the tiles is
 * what lets the figures paint while a twelve-month aggregate is still running,
 * rather than the whole screen waiting on the slowest query.
 */
export const getCharts = handler(async (req, res) => {
  const result = await service.getCharts(req.query as unknown as DashboardFilters);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});
