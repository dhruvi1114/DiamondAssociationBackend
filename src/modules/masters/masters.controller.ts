import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as service from '@modules/masters/masters.service';
import * as regService from '@modules/masters/masters.registration.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';
import { checklistFor } from '@modules/masters/masters.checklist';
/**
 * HTTP layer for the membership catalogue. Parses, delegates, responds — every
 * rule lives in the service (RULES.md).
 */

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

/** BigInt ids and Decimal money do not survive `JSON.stringify` — normalise both. */
const serialise = <T>(value: T): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Date) return val.toISOString();

      return val;
    }),
  );

const listResponse = (
  res: Response,
  result: { rows: unknown[]; total: number },
  query: { page: number; limit: number },
) =>
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(result.rows),
    pagination: { page: query.page, limit: query.limit, total: result.total },
  });

/* --- categories ----------------------------------------------------------- */

export const listCategories = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listCategories>[0];
  listResponse(res, await service.listCategories(query), query);
});

export const getCategory = handler(async (req, res) => {
  const row = await service.getCategory(BigInt(req.params.id as string));
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(row) });
});

export const createCategory = handler(async (req, res) => {
  const created = await service.createCategory(req.body as never, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.categoryCreated',
    data: serialise(created),
  });
});

export const updateCategory = handler(async (req, res) => {
  const updated = await service.updateCategory(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.categoryUpdated',
    data: serialise(updated),
  });
});

export const deleteCategory = handler(async (req, res) => {
  const id = BigInt(req.params.id as string);
  await service.deleteCategory(id, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'masters.categoryDeleted',
    data: { id: id.toString() },
  });
});

/* --- tiers ---------------------------------------------------------------- */

export const listTiers = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listTiers>[0];
  listResponse(res, await service.listTiers(query), query);
});

export const createTier = handler(async (req, res) => {
  const created = await service.createTier(req.body as never, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.tierCreated',
    data: serialise(created),
  });
});

export const updateTier = handler(async (req, res) => {
  const updated = await service.updateTier(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.tierUpdated',
    data: serialise(updated),
  });
});

export const deleteTier = handler(async (req, res) => {
  const id = BigInt(req.params.id as string);
  await service.deleteTier(id, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'masters.tierDeleted',
    data: { id: id.toString() },
  });
});

/* --- fees ----------------------------------------------------------------- */

export const listFees = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listFees>[0];
  listResponse(res, await service.listFees(query), query);
});

export const createFee = handler(async (req, res) => {
  const created = await service.createFee(req.body as never, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.feeCreated',
    data: serialise(created),
  });
});

export const updateFee = handler(async (req, res) => {
  const updated = await service.updateFee(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.feeUpdated',
    data: serialise(updated),
  });
});

/** Admin preview of the resolver — "what would this member be charged today?" */
export const resolveFee = handler(async (req, res) => {
  const query = req.query as unknown as {
    category_id: string;
    tier_id?: string;
    fee_type: Parameters<typeof service.resolveFee>[0]['feeType'];
    on_date?: string;
  };

  const resolved = await service.resolveFee({
    categoryId: BigInt(query.category_id),
    tierId: query.tier_id ? BigInt(query.tier_id) : null,
    feeType: query.fee_type,
    ...(query.on_date ? { onDate: new Date(query.on_date) } : {}),
  });

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: resolved });
});

/* --- document types ------------------------------------------------------- */

export const listDocumentTypes = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listDocumentTypes>[0];
  listResponse(res, await service.listDocumentTypes(query), query);
});

export const createDocumentType = handler(async (req, res) => {
  const created = await service.createDocumentType(req.body as never, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.documentTypeCreated',
    data: serialise(created),
  });
});

export const updateDocumentType = handler(async (req, res) => {
  const updated = await service.updateDocumentType(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.documentTypeUpdated',
    data: serialise(updated),
  });
});

export const deleteDocumentType = handler(async (req, res) => {
  const id = BigInt(req.params.id as string);
  await service.deleteDocumentType(id, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'masters.documentTypeDeleted',
    data: { id: id.toString() },
  });
});

/* --- public --------------------------------------------------------------- */

/**
 * The public membership page (C-03).
 *
 * Active categories with their active tiers and the price a new applicant would
 * pay today. Unauthenticated, so the field list is an explicit allowlist —
 * internal notes, inactive rows and anything not needed to choose a category
 * never leave the building.
 */
export const publicCatalogue = handler(async (_req, res) => {
  const data = await service.publicCatalogue();
  handleApiResponse(res, { responseType: RES_STATUS.GET, data });
});

/**
 * The plans a visitor may choose from on the membership page (C-03).
 *
 * Separate from `publicCatalogue`, which the signup form's category list is
 * still built from — the two answer different questions and merging them would
 * have made a change to one a change to the other.
 */
export const publicPlans = handler(async (_req, res) => {
  const data = await service.publicPlans();
  handleApiResponse(res, { responseType: RES_STATUS.GET, data });
});

/* --- company types -------------------------------------------------------- */

const regList = <T extends { page: number; limit: number }>(
  fn: (query: T) => Promise<{ rows: unknown[]; total: number }>,
) =>
  handler(async (req, res) => {
    const query = req.query as unknown as T;
    listResponse(res, await fn(query), query);
  });

export const listCompanyTypes = regList(regService.listCompanyTypes);
export const listCountries = regList(regService.listCountries);
export const listStates = regList(regService.listStates);
export const listCities = regList(regService.listCities);

export const getCompanyType = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.getCompanyType(BigInt(req.params.id as string))),
  });
});

export const createCompanyType = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.companyTypeCreated',
    data: serialise(await regService.createCompanyType(req.body as never, actor(req))),
  });
});

export const updateCompanyType = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.companyTypeUpdated',
    data: serialise(
      await regService.updateCompanyType(
        BigInt(req.params.id as string),
        req.body as never,
        actor(req),
      ),
    ),
  });
});

export const deleteCompanyType = handler(async (req, res) => {
  await regService.deleteCompanyType(BigInt(req.params.id as string), actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'masters.companyTypeDeleted',
  });
});

/* --- event types (M7) ------------------------------------------------------ */

export const listEventTypes = regList(regService.listEventTypes);

export const getEventType = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.getEventType(BigInt(req.params.id as string))),
  });
});

export const createEventType = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.eventTypeCreated',
    data: serialise(await regService.createEventType(req.body as never, actor(req))),
  });
});

export const updateEventType = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.eventTypeUpdated',
    data: serialise(
      await regService.updateEventType(
        BigInt(req.params.id as string),
        req.body as never,
        actor(req),
      ),
    ),
  });
});

export const deleteEventType = handler(async (req, res) => {
  await regService.deleteEventType(BigInt(req.params.id as string), actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'masters.eventTypeDeleted',
  });
});

export const getCountry = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.getCountry(BigInt(req.params.id as string))),
  });
});

export const createCountry = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.countryCreated',
    data: serialise(await regService.createCountry(req.body as never, actor(req))),
  });
});

export const updateCountry = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.countryUpdated',
    data: serialise(
      await regService.updateCountry(
        BigInt(req.params.id as string),
        req.body as never,
        actor(req),
      ),
    ),
  });
});

export const deleteCountry = handler(async (req, res) => {
  await regService.deleteCountry(BigInt(req.params.id as string), actor(req));
  handleApiResponse(res, { responseType: RES_STATUS.DELETE, messageKey: 'masters.countryDeleted' });
});

export const getState = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.getState(BigInt(req.params.id as string))),
  });
});

export const createState = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.stateCreated',
    data: serialise(await regService.createState(req.body as never, actor(req))),
  });
});

export const updateState = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.stateUpdated',
    data: serialise(
      await regService.updateState(BigInt(req.params.id as string), req.body as never, actor(req)),
    ),
  });
});

export const deleteState = handler(async (req, res) => {
  await regService.deleteState(BigInt(req.params.id as string), actor(req));
  handleApiResponse(res, { responseType: RES_STATUS.DELETE, messageKey: 'masters.stateDeleted' });
});

export const getCity = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.getCity(BigInt(req.params.id as string))),
  });
});

export const createCity = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'masters.cityCreated',
    data: serialise(await regService.createCity(req.body as never, actor(req))),
  });
});

export const updateCity = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'masters.cityUpdated',
    data: serialise(
      await regService.updateCity(BigInt(req.params.id as string), req.body as never, actor(req)),
    ),
  });
});

export const deleteCity = handler(async (req, res) => {
  await regService.deleteCity(BigInt(req.params.id as string), actor(req));
  handleApiResponse(res, { responseType: RES_STATUS.DELETE, messageKey: 'masters.cityDeleted' });
});

export const registrationOptions = handler(async (_req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.registrationOptions()),
  });
});

/**
 * The KYC checklist the public registration form renders (C-01).
 *
 * Anonymous, because the form is filled in before an account exists. The payload
 * is only what the form prints on screen — no ids, no counts, nothing about any
 * applicant.
 */
export const publicDocumentChecklist = handler(async (_req, res) => {
  const items = await checklistFor('APPLICATION');

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise({
      items: items.map((item) => ({
        code: item.code,
        name: item.name,
        description: item.description,
        is_required: item.is_required,
        sides: item.sides,
        max_size_mb: item.max_size_mb,
        allowed_mime: item.allowed_mime,
        display_order: item.display_order,
      })),
    }),
  });
});

export const publicStates = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.publicStates(BigInt(req.query.country_id as string))),
  });
});

export const publicCities = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await regService.publicCities(BigInt(req.query.state_id as string))),
  });
});

export const registrationConsent = handler(async (_req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: await regService.registrationConsent(),
  });
});
