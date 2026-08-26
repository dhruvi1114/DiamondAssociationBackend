import { Router } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { END_POINTS } from '@constant';
import type { RequestHandler } from 'express';
import { authenticate, authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/member/member.controller';
import * as teamController from '@modules/member/team.controller';
import {
  addressSchema,
  adminUpdateMemberSchema,
  changeCategorySchema,
  contactSchema,
  createChangeRequestSchema,
  idParamSchema,
  invoicePaymentParamsSchema,
  listInvoicesSchema,
  listMembersSchema,
  ownInvoicePaymentParamsSchema,
  statusChangeSchema,
  updateProfileSchema,
} from '@modules/member/member.types';
import { verifyDocumentSchema } from '@modules/document/document.types';
import { inviteTeamMemberSchema, teamStatusSchema } from '@modules/member/team.types';

/**
 * Uploads are held in memory, not written to a temp path.
 *
 * The bytes have to be sniffed and hashed before anything touches the filesystem
 * (file-storage.md §3); a disk-backed temp file would put an unvalidated blob on
 * disk first and leave one behind on every failed request. The 50 MB ceiling is
 * the hard stop — each document type applies its own, smaller limit afterwards.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
});

/** `/api/v1/members` — the member's own company record (C-14…C-17). */
export const memberRouter = Router();

memberRouter.use(authenticate);

memberRouter.get('/me', controller.getOwnProfile);

memberRouter.patch(
  '/me',
  validateRequest({ body: updateProfileSchema }),
  controller.updateOwnProfile,
);

memberRouter.get('/me/change-requests', controller.listOwnChangeRequests);

memberRouter.post(
  '/me/change-requests',
  validateRequest({ body: createChangeRequestSchema }),
  controller.requestProfileChange,
);

memberRouter.get('/me/team', teamController.listTeam);

memberRouter.post(
  '/me/team',
  validateRequest({ body: inviteTeamMemberSchema }),
  teamController.inviteTeamMember,
);

memberRouter.patch(
  '/me/team/:id/status',
  validateRequest({ params: idParamSchema, body: teamStatusSchema }),
  teamController.setTeamMemberStatus,
);

memberRouter.get('/me/contacts', controller.listContacts);
memberRouter.post('/me/contacts', validateRequest({ body: contactSchema }), controller.addContact);
memberRouter.patch(
  '/me/contacts/:id',
  validateRequest({ params: idParamSchema, body: contactSchema }),
  controller.updateContact,
);
memberRouter.delete(
  '/me/contacts/:id',
  validateRequest({ params: idParamSchema }),
  controller.removeContact,
);

memberRouter.get('/me/addresses', controller.listAddresses);
memberRouter.post('/me/addresses', validateRequest({ body: addressSchema }), controller.addAddress);
memberRouter.patch(
  '/me/addresses/:id',
  validateRequest({ params: idParamSchema, body: addressSchema }),
  controller.updateAddress,
);
memberRouter.delete(
  '/me/addresses/:id',
  validateRequest({ params: idParamSchema }),
  controller.removeAddress,
);

memberRouter.get('/me/documents', controller.getOwnChecklist);

/**
 * Multipart, so it is on the decryption bypass list (api-conventions.md §2) —
 * a file is not JSON and cannot be wrapped in the `{data: ciphertext}` envelope.
 * Authentication and validation still run exactly as everywhere else.
 */
memberRouter.post('/me/documents', upload.single('file'), controller.uploadOwnDocument);

memberRouter.delete(
  '/me/documents/:id',
  validateRequest({ params: idParamSchema }),
  controller.removeOwnDocument,
);

memberRouter.post(
  '/me/invoices/:invoiceId/pay',
  validateRequest({ params: ownInvoicePaymentParamsSchema }),
  controller.payOwnInvoice,
);

/**
 * `/api/v1/documents/:id/download` — one route, both audiences.
 *
 * The service decides entitlement (owner or permitted admin) and answers 404 to
 * everyone else, so the id cannot be used to probe for other members' files.
 */
export const documentRouter = Router();

/**
 * Pick the verifier from the token's own `aud` claim.
 *
 * The first attempt used a client-supplied `x-audience` header. Two things were
 * wrong with that: the browser could not send it (it was not on the CORS
 * allowlist, so every admin download failed preflight), and more importantly a
 * request should not get to nominate which authenticator inspects it. The claim
 * is already in the token.
 *
 * `jwt.decode` does NOT verify — it only reads the unverified payload to route
 * the request. The chosen middleware then verifies signature, expiry and
 * audience exactly as it always has, so a forged `aud` buys nothing: claiming
 * `admin` with a member token simply fails admin verification.
 */
const authenticateEitherAudience: RequestHandler = (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;

  let audience: string | undefined;
  if (token) {
    try {
      const payload = jwt.decode(token);
      const claim = typeof payload === 'object' && payload ? payload.aud : undefined;
      audience = Array.isArray(claim) ? claim[0] : claim;
    } catch {
      // Unparseable token — let the member middleware produce the 401.
    }
  }

  const middleware = audience === 'admin' ? authenticateAdmin : authenticate;

  middleware(req, res, next);
};

documentRouter.get(
  '/:id/download',
  authenticateEitherAudience,
  validateRequest({ params: idParamSchema }),
  controller.downloadDocument,
);

/** `/api/v1/invoices` — invoice and receipt PDFs, both audiences (M5). */
export const invoiceRouter = Router();

invoiceRouter.get(
  '/:invoiceId/pdf',
  authenticateEitherAudience,
  validateRequest({ params: ownInvoicePaymentParamsSchema }),
  controller.downloadInvoicePdf,
);

invoiceRouter.get(
  '/:invoiceId/receipt/pdf',
  authenticateEitherAudience,
  validateRequest({ params: ownInvoicePaymentParamsSchema }),
  controller.downloadReceiptPdf,
);

/** `/api/v1/admin/members` — staff member management (A-07…A-09, A-13). */
export const memberAdminRouter = Router();

memberAdminRouter.use(authenticateAdmin);

memberAdminRouter.get(
  END_POINTS.MEMBERS,
  authorize('member.view'),
  validateRequest({ query: listMembersSchema }),
  controller.listMembers,
);

memberAdminRouter.get(
  `${END_POINTS.MEMBERS}/:id`,
  authorize('member.view'),
  validateRequest({ params: idParamSchema }),
  controller.getMemberDetail,
);

/** `/api/v1/admin/invoices` — every invoice, org-wide, A-14. */
memberAdminRouter.get(
  END_POINTS.INVOICES,
  authorize('invoice.view'),
  validateRequest({ query: listInvoicesSchema }),
  controller.listInvoicesAdmin,
);

memberAdminRouter.patch(
  `${END_POINTS.MEMBERS}/:id`,
  authorize('member.manage'),
  validateRequest({ params: idParamSchema, body: adminUpdateMemberSchema }),
  controller.adminUpdateMember,
);

memberAdminRouter.patch(
  `${END_POINTS.MEMBERS}/:id/category`,
  authorize('member.manage'),
  validateRequest({ params: idParamSchema, body: changeCategorySchema }),
  controller.changeCategory,
);

/**
 * Status changes are `member.status`, which ACCOUNTS deliberately does not hold:
 * finance owns money, not membership standing (rbac.md §3).
 */
memberAdminRouter.post(
  `${END_POINTS.MEMBERS}/:id/suspend`,
  authorize('member.status'),
  validateRequest({ params: idParamSchema, body: statusChangeSchema }),
  controller.suspendMember,
);

memberAdminRouter.post(
  `${END_POINTS.MEMBERS}/:id/reactivate`,
  authorize('member.status'),
  validateRequest({ params: idParamSchema, body: statusChangeSchema }),
  controller.reactivateMember,
);

memberAdminRouter.post(
  `${END_POINTS.MEMBERS}/:id/terminate`,
  authorize('member.status'),
  validateRequest({ params: idParamSchema, body: statusChangeSchema }),
  controller.terminateMember,
);

/**
 * No online checkout exists yet (customer/ApplicationTracker.tsx). Until one
 * does, staff confirm an offline payment landed and record it here —
 * `payment.record` is ACCOUNTS' own permission, separate from `member.status`.
 */
memberAdminRouter.post(
  `${END_POINTS.MEMBERS}/:id/invoices/:invoiceId/mark-paid`,
  authorize('payment.record'),
  validateRequest({ params: invoicePaymentParamsSchema }),
  controller.recordInvoicePayment,
);

memberAdminRouter.get(
  `${END_POINTS.MEMBERS}/:id/documents`,
  authorize('member.view'),
  validateRequest({ params: idParamSchema }),
  controller.listMemberDocuments,
);

memberAdminRouter.patch(
  `${END_POINTS.DOCUMENTS}/:id/verify`,
  authorize('document.verify'),
  validateRequest({ params: idParamSchema, body: verifyDocumentSchema }),
  controller.verifyDocument,
);
