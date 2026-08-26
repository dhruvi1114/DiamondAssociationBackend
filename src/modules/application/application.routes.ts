import { Router } from 'express';
import multer from 'multer';
import { END_POINTS } from '@constant';
import { authenticate, authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/application/application.controller';
import { verifyDocumentSchema } from '@modules/document/document.types';
import {
  approveSchema,
  documentIdParamSchema,
  idParamSchema,
  listApplicationsSchema,
  reassignSchema,
  rejectSchema,
  saveDraftSchema,
} from '@modules/application/application.types';

/** Same memory-backed upload rules as member KYC — bytes are sniffed before
 *  anything touches disk (file-storage.md §3). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

/** `/api/v1/applications` — the applicant's own application (C-11…C-13). */
export const applicationRouter = Router();

applicationRouter.use(authenticate);

applicationRouter.get('/me', controller.getOwnApplication);
applicationRouter.get('/me/history', controller.listOwnApplications);

applicationRouter.patch(
  '/:id',
  validateRequest({ params: idParamSchema, body: saveDraftSchema }),
  controller.saveDraft,
);

applicationRouter.get(
  '/:id/completeness',
  validateRequest({ params: idParamSchema }),
  controller.getCompleteness,
);

applicationRouter.post(
  '/:id/submit',
  validateRequest({ params: idParamSchema }),
  controller.submit,
);

// Multipart, so it is on the decryption bypass list (api-conventions.md §2).
applicationRouter.post(
  '/:id/documents',
  validateRequest({ params: idParamSchema }),
  upload.single('file'),
  controller.uploadDocument,
);

applicationRouter.get(
  '/:id/documents/:documentId/download',
  validateRequest({ params: documentIdParamSchema }),
  controller.downloadOwnDocument,
);

applicationRouter.delete(
  '/:id/documents/:documentId',
  validateRequest({ params: documentIdParamSchema }),
  controller.removeDocument,
);

applicationRouter.post(
  '/:id/withdraw',
  validateRequest({ params: idParamSchema }),
  controller.withdraw,
);

/**
 * `/api/v1/admin/applications` — the reviewer queue (A-03…A-05, A-33).
 *
 * Permissions here say WHAT a reviewer may do. Whose queue an application is in
 * is a separate check inside the service, against the stage's role — holding
 * `application.approve` does not let you decide someone else's stage
 * (rbac.md §4).
 */
export const applicationAdminRouter = Router();

applicationAdminRouter.use(authenticateAdmin);

applicationAdminRouter.get(
  END_POINTS.APPLICATIONS,
  authorize('application.view'),
  validateRequest({ query: listApplicationsSchema }),
  controller.listForReview,
);

applicationAdminRouter.get(
  `${END_POINTS.APPLICATIONS}/workflow`,
  authorize('workflow.view'),
  controller.getWorkflow,
);

applicationAdminRouter.get(
  `${END_POINTS.APPLICATIONS}/:id`,
  authorize('application.view'),
  validateRequest({ params: idParamSchema }),
  controller.getForReview,
);

applicationAdminRouter.post(
  `${END_POINTS.APPLICATIONS}/:id/approve`,
  authorize('application.approve'),
  validateRequest({ params: idParamSchema, body: approveSchema }),
  controller.approve,
);

/**
 * The only way back to the applicant.
 *
 * `/return` was retired with the two-action model (spec D-1): it and Reject said
 * nearly the same thing to the applicant and nothing distinguishable to the
 * reviewer. What this route does now depends on the resubmission count, not on
 * which of two buttons was pressed.
 */
applicationAdminRouter.post(
  `${END_POINTS.APPLICATIONS}/:id/reject`,
  authorize('application.reject'),
  validateRequest({ params: idParamSchema, body: rejectSchema }),
  controller.reject,
);

applicationAdminRouter.post(
  `${END_POINTS.APPLICATIONS}/:id/reassign`,
  authorize('application.reassign'),
  validateRequest({ params: idParamSchema, body: reassignSchema }),
  controller.reassign,
);

applicationAdminRouter.get(
  `${END_POINTS.APPLICATIONS}/:id/documents/:documentId/download`,
  authorize('application.view'),
  validateRequest({ params: documentIdParamSchema }),
  controller.downloadDocumentAsAdmin,
);

applicationAdminRouter.patch(
  `${END_POINTS.APPLICATIONS}/:id/documents/:documentId/verify`,
  authorize('document.verify'),
  validateRequest({ params: documentIdParamSchema, body: verifyDocumentSchema }),
  controller.verifyDocument,
);
