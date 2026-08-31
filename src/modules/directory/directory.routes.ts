import { Router } from 'express';

import { authenticate, validateRequest } from '@middleware';
import * as controller from '@modules/directory/directory.controller';
import { directorySlugSchema, listDirectorySchema } from '@modules/directory/directory.types';
import { idParamSchema } from '@modules/member/member.types';

/**
 * `/api/v1/directory` — the member directory. One router, and only one.
 *
 * There is deliberately no public sibling. News has both, because an article is
 * written to be read by anyone; a member's contact details are not. Decision D1
 * (docs/client-decisions.md) made this members-only, so an anonymous audience
 * has no endpoint to reach — not a narrower response, no endpoint at all.
 *
 * If you are here to add a `/public/directory` router: don't. That is the one
 * thing this module exists to not have. See
 * docs/specs/2026-08-31-member-directory.md §2.
 *
 * `authenticate` proves there is a session. It does NOT prove membership —
 * `directory.gate.ts` does that, per request, from the database.
 */
export const directoryRouter = Router();

directoryRouter.use(authenticate);

directoryRouter.get('/', validateRequest({ query: listDirectorySchema }), controller.listDirectory);

directoryRouter.get('/filters', controller.getFilters);

directoryRouter.get(
  '/media/:id',
  validateRequest({ params: idParamSchema }),
  controller.serveDirectoryLogo,
);

/* Last: a bare `:slug` must not swallow `/filters` or `/media/:id`. */
directoryRouter.get(
  '/:slug',
  validateRequest({ params: directorySlugSchema }),
  controller.getDirectoryMember,
);
