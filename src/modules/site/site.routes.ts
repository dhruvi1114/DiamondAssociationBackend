import { Router } from 'express';

import { END_POINTS } from '@constant';
import * as controller from '@modules/site/site.controller';

/**
 * `/api/v1/public/site` — the numbers the marketing homepage states as fact.
 *
 * Unauthenticated by definition: this is the page a stranger lands on. Nothing
 * here is member data — a count, a country name and the company names of
 * members who chose to be listed publicly.
 */
export const sitePublicRouter = Router();

sitePublicRouter.get(`${END_POINTS.SITE}/stats`, controller.siteStats);
