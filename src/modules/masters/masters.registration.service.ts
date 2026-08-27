import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { getSetting, SETTING_KEYS } from '@helpers/settings';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import * as repo from '@modules/masters/masters.repository';
import type {
  CreateCityInput,
  CreateCompanyTypeInput,
  CreateEventTypeInput,
  CreateCountryInput,
  CreateStateInput,
  UpdateCityInput,
  UpdateCompanyTypeInput,
  UpdateEventTypeInput,
  UpdateCountryInput,
  UpdateStateInput,
} from '@modules/masters/masters.types';
import { AppError } from '@utils/appError';

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const notFound = (key: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: key });

const conflict = (key: string, details?: Record<string, unknown>): AppError =>
  new AppError({
    errorType: ERROR_TYPES.CONFLICT,
    messageKey: key,
    ...(details ? { details } : {}),
  });

const audited = (actor: Actor) => ({
  actorType: 'ADMIN' as const,
  actorId: actor.id,
  ip: actor.ip,
  userAgent: actor.userAgent,
  requestId: actor.requestId,
});

const paged = <T extends { total: bigint }>(rows: T[]): { rows: T[]; total: number } => ({
  rows,
  total: rows.length > 0 ? Number(rows[0]!.total) : 0,
});

const selectedActiveState = (status: string | undefined): boolean | undefined => {
  if (!status) return undefined;
  const chosen = new Set(status.split(','));
  if (chosen.size !== 1) return undefined;
  return chosen.has('active');
};

/* --- company types -------------------------------------------------------- */

export const listCompanyTypes = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  status?: string | undefined;
}) =>
  paged(
    await repo.listCompanyTypes(prisma, {
      search: query.search,
      isActive: selectedActiveState(query.status),
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const getCompanyType = async (id: bigint) => {
  const row = await prisma.companyType.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw notFound('masters.companyTypeNotFound');
  return row;
};

export const createCompanyType = async (input: CreateCompanyTypeInput, actor: Actor) => {
  const existing = await prisma.companyType.findFirst({ where: { code: input.code } });

  if (existing?.deletedAt === null) throw conflict('masters.duplicateCode');

  const row =
    existing !== null
      ? await prisma.companyType.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            display_order: input.display_order ?? 0,
            is_active: input.is_active ?? true,
            deletedAt: null,
          },
        })
      : await prisma.companyType.create({
          data: {
            code: input.code,
            name: input.name,
            display_order: input.display_order ?? 0,
            is_active: input.is_active ?? true,
          },
        });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.COMPANY_TYPE_CREATED,
    entityName: 'CompanyTypes',
    entityId: row.id,
    after: { code: row.code, name: row.name },
  });

  return row;
};

export const updateCompanyType = async (
  id: bigint,
  input: UpdateCompanyTypeInput,
  actor: Actor,
) => {
  const before = await getCompanyType(id);
  const updated = await prisma.companyType.update({ where: { id }, data: input });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.COMPANY_TYPE_UPDATED,
    entityName: 'CompanyTypes',
    entityId: id,
    before: { name: before.name, display_order: before.display_order, is_active: before.is_active },
    after: {
      name: updated.name,
      display_order: updated.display_order,
      is_active: updated.is_active,
    },
  });

  return updated;
};

export const deleteCompanyType = async (id: bigint, actor: Actor) => {
  const row = await getCompanyType(id);
  const members = await prisma.member.count({
    where: { company_type_id: id, deletedAt: null },
  });

  if (members > 0) throw conflict('masters.companyTypeInUse', { members });

  await prisma.companyType.update({ where: { id }, data: { deletedAt: new Date() } });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.COMPANY_TYPE_DELETED,
    entityName: 'CompanyTypes',
    entityId: id,
    before: { code: row.code, name: row.name },
  });
};

/* --- event types (M7) ------------------------------------------------------ */

export const listEventTypes = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  status?: string | undefined;
}) =>
  paged(
    await repo.listEventTypes(prisma, {
      search: query.search,
      isActive: selectedActiveState(query.status),
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const getEventType = async (id: bigint) => {
  const row = await prisma.eventType.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw notFound('masters.eventTypeNotFound');
  return row;
};

/**
 * Create, or revive a row soft-deleted earlier under the same code.
 *
 * Reviving rather than inserting a second row: the code is unique across
 * deleted rows too, so a plain insert would collide with a type somebody
 * removed last year — and re-adding "Seminar" is almost always an undo.
 */
export const createEventType = async (input: CreateEventTypeInput, actor: Actor) => {
  const existing = await prisma.eventType.findFirst({ where: { code: input.code } });

  if (existing?.deletedAt === null) throw conflict('masters.duplicateCode');

  const row =
    existing !== null
      ? await prisma.eventType.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            display_order: input.display_order ?? 0,
            is_active: input.is_active ?? true,
            deletedAt: null,
            updated_by_admin_id: actor.id,
          },
        })
      : await prisma.eventType.create({
          data: {
            code: input.code,
            name: input.name,
            display_order: input.display_order ?? 0,
            is_active: input.is_active ?? true,
            created_by_admin_id: actor.id,
          },
        });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.EVENT_TYPE_CREATED,
    entityName: 'EventTypes',
    entityId: row.id,
    after: { code: row.code, name: row.name },
  });

  return row;
};

export const updateEventType = async (id: bigint, input: UpdateEventTypeInput, actor: Actor) => {
  const before = await getEventType(id);
  const updated = await prisma.eventType.update({
    where: { id },
    data: { ...input, updated_by_admin_id: actor.id },
  });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.EVENT_TYPE_UPDATED,
    entityName: 'EventTypes',
    entityId: id,
    before: { name: before.name, display_order: before.display_order, is_active: before.is_active },
    after: {
      name: updated.name,
      display_order: updated.display_order,
      is_active: updated.is_active,
    },
  });

  return updated;
};

/**
 * Remove a type nothing is using.
 *
 * Refused while any event still carries it, with the count in the message.
 * Deleting it would either orphan those events or silently retype them, and
 * neither is a thing a master screen should be able to do to the event history.
 * Deactivating is the answer, and the message says so.
 */
export const deleteEventType = async (id: bigint, actor: Actor) => {
  const row = await getEventType(id);
  const events = await prisma.event.count({ where: { event_type_id: id, deletedAt: null } });

  if (events > 0) throw conflict('masters.eventTypeInUse', { events });

  await prisma.eventType.update({
    where: { id },
    data: { deletedAt: new Date(), updated_by_admin_id: actor.id },
  });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.EVENT_TYPE_DELETED,
    entityName: 'EventTypes',
    entityId: id,
    before: { code: row.code, name: row.name },
  });
};

/* --- countries ------------------------------------------------------------ */

export const listCountries = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  status?: string | undefined;
}) =>
  paged(
    await repo.listCountries(prisma, {
      search: query.search,
      isActive: selectedActiveState(query.status),
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const getCountry = async (id: bigint) => {
  const row = await prisma.country.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw notFound('masters.countryNotFound');
  return row;
};

export const createCountry = async (input: CreateCountryInput, actor: Actor) => {
  const existing = await prisma.country.findFirst({ where: { iso_code: input.iso_code } });
  if (existing?.deletedAt === null) throw conflict('masters.duplicateCode');

  const row =
    existing !== null
      ? await prisma.country.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            display_order: input.display_order ?? 0,
            is_active: input.is_active ?? true,
            deletedAt: null,
          },
        })
      : await prisma.country.create({
          data: {
            iso_code: input.iso_code,
            name: input.name,
            display_order: input.display_order ?? 0,
            is_active: input.is_active ?? true,
          },
        });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.COUNTRY_CREATED,
    entityName: 'Countries',
    entityId: row.id,
    after: { iso_code: row.iso_code, name: row.name },
  });

  return row;
};

export const updateCountry = async (id: bigint, input: UpdateCountryInput, actor: Actor) => {
  const before = await getCountry(id);
  const updated = await prisma.country.update({ where: { id }, data: input });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.COUNTRY_UPDATED,
    entityName: 'Countries',
    entityId: id,
    before: { name: before.name, is_active: before.is_active },
    after: { name: updated.name, is_active: updated.is_active },
  });

  return updated;
};

export const deleteCountry = async (id: bigint, actor: Actor) => {
  const row = await getCountry(id);
  const states = await prisma.state.count({ where: { country_id: id, deletedAt: null } });
  if (states > 0) throw conflict('masters.countryInUse', { states });

  await prisma.country.update({ where: { id }, data: { deletedAt: new Date() } });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.COUNTRY_DELETED,
    entityName: 'Countries',
    entityId: id,
    before: { iso_code: row.iso_code, name: row.name },
  });
};

/* --- states --------------------------------------------------------------- */

export const listStates = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  status?: string | undefined;
  country_id?: string | undefined;
}) =>
  paged(
    await repo.listStates(prisma, {
      search: query.search,
      isActive: selectedActiveState(query.status),
      countryIds: query.country_id,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const getState = async (id: bigint) => {
  const row = await prisma.state.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw notFound('masters.stateNotFound');
  return row;
};

export const createState = async (input: CreateStateInput, actor: Actor) => {
  const countryId = BigInt(input.country_id);
  await getCountry(countryId);

  const existing = await prisma.state.findFirst({
    where: { country_id: countryId, code: input.code },
  });
  if (existing?.deletedAt === null) throw conflict('masters.duplicateCode');

  const row =
    existing !== null
      ? await prisma.state.update({
          where: { id: existing.id },
          data: { name: input.name, is_active: input.is_active ?? true, deletedAt: null },
        })
      : await prisma.state.create({
          data: {
            country_id: countryId,
            code: input.code,
            name: input.name,
            is_active: input.is_active ?? true,
          },
        });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.STATE_CREATED,
    entityName: 'States',
    entityId: row.id,
    after: { code: row.code, name: row.name, country_id: countryId.toString() },
  });

  return row;
};

export const updateState = async (id: bigint, input: UpdateStateInput, actor: Actor) => {
  const before = await getState(id);
  const updated = await prisma.state.update({ where: { id }, data: input });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.STATE_UPDATED,
    entityName: 'States',
    entityId: id,
    before: { name: before.name, is_active: before.is_active },
    after: { name: updated.name, is_active: updated.is_active },
  });

  return updated;
};

export const deleteState = async (id: bigint, actor: Actor) => {
  const row = await getState(id);
  const cities = await prisma.city.count({ where: { state_id: id, deletedAt: null } });
  if (cities > 0) throw conflict('masters.stateInUse', { cities });

  await prisma.state.update({ where: { id }, data: { deletedAt: new Date() } });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.STATE_DELETED,
    entityName: 'States',
    entityId: id,
    before: { code: row.code, name: row.name },
  });
};

/* --- cities --------------------------------------------------------------- */

export const listCities = async (query: {
  page: number;
  limit: number;
  search?: string | undefined;
  status?: string | undefined;
  state_id?: string | undefined;
}) =>
  paged(
    await repo.listCities(prisma, {
      search: query.search,
      isActive: selectedActiveState(query.status),
      stateIds: query.state_id,
      limit: query.limit,
      offset: (query.page - 1) * query.limit,
    }),
  );

export const getCity = async (id: bigint) => {
  const row = await prisma.city.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw notFound('masters.cityNotFound');
  return row;
};

export const createCity = async (input: CreateCityInput, actor: Actor) => {
  const stateId = BigInt(input.state_id);
  await getState(stateId);

  const existing = await prisma.city.findFirst({
    where: { state_id: stateId, name: input.name },
  });
  if (existing?.deletedAt === null) throw conflict('masters.duplicateName');

  const row =
    existing !== null
      ? await prisma.city.update({
          where: { id: existing.id },
          data: { is_active: input.is_active ?? true, deletedAt: null },
        })
      : await prisma.city.create({
          data: { state_id: stateId, name: input.name, is_active: input.is_active ?? true },
        });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.CITY_CREATED,
    entityName: 'Cities',
    entityId: row.id,
    after: { name: row.name, state_id: stateId.toString() },
  });

  return row;
};

export const updateCity = async (id: bigint, input: UpdateCityInput, actor: Actor) => {
  const before = await getCity(id);
  const updated = await prisma.city.update({ where: { id }, data: input });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.CITY_UPDATED,
    entityName: 'Cities',
    entityId: id,
    before: { name: before.name, is_active: before.is_active },
    after: { name: updated.name, is_active: updated.is_active },
  });

  return updated;
};

export const deleteCity = async (id: bigint, actor: Actor) => {
  const row = await getCity(id);
  const addresses = await prisma.memberAddress.count({
    where: { city_id: id, deletedAt: null },
  });
  if (addresses > 0) throw conflict('masters.cityInUse', { addresses });

  await prisma.city.update({ where: { id }, data: { deletedAt: new Date() } });

  await writeAudit(prisma, {
    ...audited(actor),
    action: AUDIT_ACTIONS.CITY_DELETED,
    entityName: 'Cities',
    entityId: id,
    before: { name: row.name },
  });
};

/* --- public registration reads ------------------------------------------- */

export const registrationOptions = async () => ({
  company_types: await repo.activeCompanyTypes(prisma),
  countries: await repo.activeCountries(prisma),
});

export const publicStates = async (countryId: bigint) => repo.activeStates(prisma, countryId);

export const publicCities = async (stateId: bigint) => repo.activeCities(prisma, stateId);

export const registrationConsent = async () => ({
  text: (await getSetting(SETTING_KEYS.REGISTRATION_CONSENT_TEXT)) ?? '',
});
