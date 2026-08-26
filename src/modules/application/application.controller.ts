import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as documents from '@modules/document/document.service';
import * as service from '@modules/application/application.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/** HTTP layer for applications and approval decisions. Rules live in the service. */

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    void fn(req, res).catch(next);
  };

const base = (req: Request) => {
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

/** Reviewer identity: roles decide whose queue this is (rbac.md §4). */
const reviewer = (req: Request) => ({
  ...base(req),
  roles: req.actor?.roles ?? [],
  isSuperAdmin: req.actor?.isSuperAdmin ?? false,
});

const serialise = <T>(value: T): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, val: unknown) => {
      if (key === 'file_path') return undefined;
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Date) return val.toISOString();

      return val;
    }),
  );

/* --- applicant ------------------------------------------------------------- */

export const getOwnApplication = handler(async (req, res) => {
  const actor = base(req);
  const draft = await service.getOrCreateDraft(actor.id, actor);
  const detail = await service.getOwnDetail(draft.id, actor.id);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(detail) });
});

export const listOwnApplications = handler(async (req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await service.listOwn(base(req).id)),
  });
});

export const saveDraft = handler(async (req, res) => {
  const actor = base(req);
  const updated = await service.saveDraft(
    BigInt(req.params.id as string),
    actor.id,
    req.body as never,
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'application.saved',
    data: serialise(updated),
  });
});

export const getCompleteness = handler(async (req, res) => {
  const actor = base(req);
  const result = await service.completeness(BigInt(req.params.id as string), actor.id);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: result });
});

export const submit = handler(async (req, res) => {
  const actor = base(req);
  const updated = await service.submit(BigInt(req.params.id as string), actor.id, actor);

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'application.submitted',
    data: serialise(updated),
  });
});

export const withdraw = handler(async (req, res) => {
  const actor = base(req);
  const updated = await service.withdraw(BigInt(req.params.id as string), actor.id, actor);

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'application.withdrawn',
    data: serialise(updated),
  });
});

/* --- reviewer -------------------------------------------------------------- */

export const listForReview = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listForReview>[0];
  const result = await service.listForReview(query, reviewer(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(result.rows),
    pagination: { page: query.page, limit: query.limit, total: result.total },
  });
});

export const getForReview = handler(async (req, res) => {
  const detail = await service.getDetailForReview(BigInt(req.params.id as string));
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(detail) });
});

const decisionHandler = (
  fn: (id: bigint, input: never, actor: ReturnType<typeof reviewer>) => Promise<unknown>,
  messageKey: string,
) =>
  handler(async (req, res) => {
    const result = await fn(BigInt(req.params.id as string), req.body as never, reviewer(req));

    handleApiResponse(res, {
      responseType: RES_STATUS.ACTION,
      messageKey,
      data: serialise(result),
    });
  });

export const approve = decisionHandler(service.approve as never, 'application.approved');
export const reject = decisionHandler(service.reject as never, 'application.rejected');
export const reassign = decisionHandler(service.reassign as never, 'application.reassigned');

export const getWorkflow = handler(async (_req, res) => {
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await service.getWorkflow()),
  });
});

/* --- application documents -------------------------------------------------- */

export const uploadDocument = handler(async (req, res) => {
  const actor = base(req);
  const applicationId = BigInt(req.params.id as string);
  // Ownership first: an id in the URL is a claim, not a credential.
  await service.getOwnDetail(applicationId, actor.id);

  const file = req.file;
  if (!file) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'document.fileRequired',
    });
  }

  const code = (req.body as { document_type_code?: unknown }).document_type_code;
  if (typeof code !== 'string' || code.length === 0) {
    throw new AppError({
      errorType: ERROR_TYPES.VALIDATION_ERROR,
      messageKey: 'document.typeRequired',
    });
  }

  const created = await documents.uploadApplicationDocument(
    {
      applicationId,
      documentTypeCode: code,
      originalName: file.originalname,
      buffer: file.buffer,
      declaredMime: file.mimetype,
    },
    actor,
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'document.uploaded',
    data: serialise(created),
  });
});

export const removeDocument = handler(async (req, res) => {
  const actor = base(req);
  const applicationId = BigInt(req.params.id as string);
  await service.getOwnDetail(applicationId, actor.id);

  const documentId = BigInt(req.params.documentId as string);
  await documents.removeApplicationDocument(applicationId, documentId, actor);

  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'document.removed',
    data: { id: documentId.toString() },
  });
});

/**
 * Stream an application document to the applicant who filed it or to staff.
 *
 * Stage 1 of the workflow is document verification, so a reviewer who cannot open
 * the file cannot do the job the stage exists for. Entitlement is decided in the
 * service and a stranger gets 404 rather than 403, so ids cannot be probed.
 */
const streamDocument = handler(async (req, res) => {
  const actor = base(req);
  const isAdmin = req.actor?.type === 'ADMIN';
  const applicationId = BigInt(req.params.id as string);

  const file = await documents.openApplicationDocumentForDownload(
    applicationId,
    BigInt(req.params.documentId as string),
    { userId: isAdmin ? null : actor.id, isAdmin },
    actor,
  );

  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', file.size.toString());
  // `attachment` so a PDF or image never renders in the tab it was fetched from.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename.replace(/["\r\n]/g, '')}"`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  file.stream.pipe(res);
});

export const downloadOwnDocument = streamDocument;
export const downloadDocumentAsAdmin = streamDocument;

export const verifyDocument = handler(async (req, res) => {
  const body = req.body as { status: 'VERIFIED' | 'REJECTED'; remarks?: string };
  const updated = await documents.verifyApplicationDocument(
    BigInt(req.params.documentId as string),
    { status: body.status, remarks: body.remarks },
    reviewer(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: body.status === 'VERIFIED' ? 'document.verified' : 'document.rejected',
    data: serialise(updated),
  });
});
