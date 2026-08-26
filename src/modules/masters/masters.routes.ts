import { Router } from 'express';
import { END_POINTS } from '@constant';
import { authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/masters/masters.controller';
import {
  categoryListQuerySchema,
  cityListQuerySchema,
  companyTypeListQuerySchema,
  countryListQuerySchema,
  createCategorySchema,
  createCitySchema,
  createCompanyTypeSchema,
  createCountrySchema,
  createDocumentTypeSchema,
  createFeeSchema,
  createStateSchema,
  createTierSchema,
  documentTypeListQuerySchema,
  feeListQuerySchema,
  idParamSchema,
  publicCitiesQuerySchema,
  publicStatesQuerySchema,
  resolveFeeQuerySchema,
  stateListQuerySchema,
  tierListQuerySchema,
  updateCategorySchema,
  updateCitySchema,
  updateCompanyTypeSchema,
  updateCountrySchema,
  updateDocumentTypeSchema,
  updateFeeSchema,
  updateStateSchema,
  updateTierSchema,
} from '@modules/masters/masters.types';

/**
 * `/api/v1/admin/...` — the membership catalogue (M2, screens A-10/A-11/A-12).
 */
export const mastersAdminRouter = Router();

mastersAdminRouter.use(authenticateAdmin);

/* --- categories ----------------------------------------------------------- */

mastersAdminRouter.get(
  END_POINTS.CATEGORIES,
  authorize('category.view'),
  validateRequest({ query: categoryListQuerySchema }),
  controller.listCategories,
);

mastersAdminRouter.post(
  END_POINTS.CATEGORIES,
  authorize('category.manage'),
  validateRequest({ body: createCategorySchema }),
  controller.createCategory,
);

mastersAdminRouter.get(
  `${END_POINTS.CATEGORIES}/:id`,
  authorize('category.view'),
  validateRequest({ params: idParamSchema }),
  controller.getCategory,
);

mastersAdminRouter.patch(
  `${END_POINTS.CATEGORIES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema, body: updateCategorySchema }),
  controller.updateCategory,
);

mastersAdminRouter.delete(
  `${END_POINTS.CATEGORIES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteCategory,
);

/* --- tiers ---------------------------------------------------------------- */

mastersAdminRouter.get(
  END_POINTS.TIERS,
  authorize('category.view'),
  validateRequest({ query: tierListQuerySchema }),
  controller.listTiers,
);

mastersAdminRouter.post(
  END_POINTS.TIERS,
  authorize('category.manage'),
  validateRequest({ body: createTierSchema }),
  controller.createTier,
);

mastersAdminRouter.patch(
  `${END_POINTS.TIERS}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema, body: updateTierSchema }),
  controller.updateTier,
);

mastersAdminRouter.delete(
  `${END_POINTS.TIERS}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteTier,
);

/* --- fees ----------------------------------------------------------------- */

mastersAdminRouter.get(
  END_POINTS.FEES,
  authorize('fee.view'),
  validateRequest({ query: feeListQuerySchema }),
  controller.listFees,
);

mastersAdminRouter.get(
  `${END_POINTS.FEES}/resolve`,
  authorize('fee.view'),
  validateRequest({ query: resolveFeeQuerySchema }),
  controller.resolveFee,
);

mastersAdminRouter.post(
  END_POINTS.FEES,
  authorize('fee.manage'),
  validateRequest({ body: createFeeSchema }),
  controller.createFee,
);

mastersAdminRouter.patch(
  `${END_POINTS.FEES}/:id`,
  authorize('fee.manage'),
  validateRequest({ params: idParamSchema, body: updateFeeSchema }),
  controller.updateFee,
);

/* --- document types (M2) -------------------------------------------------- */

mastersAdminRouter.get(
  END_POINTS.DOCUMENT_TYPES,
  authorize('category.view'),
  validateRequest({ query: documentTypeListQuerySchema }),
  controller.listDocumentTypes,
);

mastersAdminRouter.post(
  END_POINTS.DOCUMENT_TYPES,
  authorize('category.manage'),
  validateRequest({ body: createDocumentTypeSchema }),
  controller.createDocumentType,
);

mastersAdminRouter.patch(
  `${END_POINTS.DOCUMENT_TYPES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema, body: updateDocumentTypeSchema }),
  controller.updateDocumentType,
);

mastersAdminRouter.delete(
  `${END_POINTS.DOCUMENT_TYPES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteDocumentType,
);

/* --- company types (M5) --------------------------------------------------- */

mastersAdminRouter.get(
  END_POINTS.COMPANY_TYPES,
  authorize('category.view'),
  validateRequest({ query: companyTypeListQuerySchema }),
  controller.listCompanyTypes,
);

mastersAdminRouter.post(
  END_POINTS.COMPANY_TYPES,
  authorize('category.manage'),
  validateRequest({ body: createCompanyTypeSchema }),
  controller.createCompanyType,
);

mastersAdminRouter.get(
  `${END_POINTS.COMPANY_TYPES}/:id`,
  authorize('category.view'),
  validateRequest({ params: idParamSchema }),
  controller.getCompanyType,
);

mastersAdminRouter.patch(
  `${END_POINTS.COMPANY_TYPES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema, body: updateCompanyTypeSchema }),
  controller.updateCompanyType,
);

mastersAdminRouter.delete(
  `${END_POINTS.COMPANY_TYPES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteCompanyType,
);

/* --- countries / states / cities (M5) --------------------------------------- */

mastersAdminRouter.get(
  END_POINTS.COUNTRIES,
  authorize('category.view'),
  validateRequest({ query: countryListQuerySchema }),
  controller.listCountries,
);

mastersAdminRouter.post(
  END_POINTS.COUNTRIES,
  authorize('category.manage'),
  validateRequest({ body: createCountrySchema }),
  controller.createCountry,
);

mastersAdminRouter.get(
  `${END_POINTS.COUNTRIES}/:id`,
  authorize('category.view'),
  validateRequest({ params: idParamSchema }),
  controller.getCountry,
);

mastersAdminRouter.patch(
  `${END_POINTS.COUNTRIES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema, body: updateCountrySchema }),
  controller.updateCountry,
);

mastersAdminRouter.delete(
  `${END_POINTS.COUNTRIES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteCountry,
);

mastersAdminRouter.get(
  END_POINTS.STATES,
  authorize('category.view'),
  validateRequest({ query: stateListQuerySchema }),
  controller.listStates,
);

mastersAdminRouter.post(
  END_POINTS.STATES,
  authorize('category.manage'),
  validateRequest({ body: createStateSchema }),
  controller.createState,
);

mastersAdminRouter.get(
  `${END_POINTS.STATES}/:id`,
  authorize('category.view'),
  validateRequest({ params: idParamSchema }),
  controller.getState,
);

mastersAdminRouter.patch(
  `${END_POINTS.STATES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema, body: updateStateSchema }),
  controller.updateState,
);

mastersAdminRouter.delete(
  `${END_POINTS.STATES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteState,
);

mastersAdminRouter.get(
  END_POINTS.CITIES,
  authorize('category.view'),
  validateRequest({ query: cityListQuerySchema }),
  controller.listCities,
);

mastersAdminRouter.post(
  END_POINTS.CITIES,
  authorize('category.manage'),
  validateRequest({ body: createCitySchema }),
  controller.createCity,
);

mastersAdminRouter.get(
  `${END_POINTS.CITIES}/:id`,
  authorize('category.view'),
  validateRequest({ params: idParamSchema }),
  controller.getCity,
);

mastersAdminRouter.patch(
  `${END_POINTS.CITIES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema, body: updateCitySchema }),
  controller.updateCity,
);

mastersAdminRouter.delete(
  `${END_POINTS.CITIES}/:id`,
  authorize('category.manage'),
  validateRequest({ params: idParamSchema }),
  controller.deleteCity,
);

/**
 * `/api/v1/public/...` — anonymous registration and membership catalogue reads.
 */
export const mastersPublicRouter = Router();

mastersPublicRouter.get(END_POINTS.MEMBERSHIP, controller.publicCatalogue);
mastersPublicRouter.get(END_POINTS.REGISTRATION_OPTIONS, controller.registrationOptions);
mastersPublicRouter.get(END_POINTS.DOCUMENT_CHECKLIST, controller.publicDocumentChecklist);
mastersPublicRouter.get(
  END_POINTS.STATES,
  validateRequest({ query: publicStatesQuerySchema }),
  controller.publicStates,
);
mastersPublicRouter.get(
  END_POINTS.CITIES,
  validateRequest({ query: publicCitiesQuerySchema }),
  controller.publicCities,
);
mastersPublicRouter.get(END_POINTS.REGISTRATION_CONSENT, controller.registrationConsent);
