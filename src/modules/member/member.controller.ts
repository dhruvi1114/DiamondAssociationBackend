import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { MemberStatus } from '@prisma/client';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { RES_STATUS } from '@constant/message.constant';
import * as documentService from '@modules/document/document.service';
import * as logo from '@modules/member/member.logo.service';
import * as service from '@modules/member/member.service';
import { AppError } from '@utils/appError';
import { handleApiResponse } from '@utils/handleResponse';

/**
 * HTTP layer for the member record.
 *
 * Member-facing handlers never take an id from the request: the company is
 * resolved from the token. An id in the body would let one member address
 * another's record, which no amount of validation downstream can undo
 * (rbac.md §5).
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

/**
 * BigInt ids and Date values do not survive `JSON.stringify` — normalise both.
 *
 * `file_path` is dropped everywhere. It is the storage key, and
 * `api-conventions.md` §8 says an upload returns metadata only: the client has
 * no use for it, downloads go through `/documents/:id/download`, and shipping
 * internal layout to every caller is how a future S3 bucket name ends up in a
 * browser devtools tab. The key is unreachable over HTTP either way — this stops
 * it being *published*, which is a different question from whether it is usable.
 */
const REDACTED_KEYS = new Set(['file_path', 'logo_path']);

const serialise = <T>(value: T): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, val: unknown) => {
      if (REDACTED_KEYS.has(key)) return undefined;
      if (typeof val === 'bigint') return val.toString();
      if (val instanceof Date) return val.toISOString();

      return val;
    }),
  );

/** The caller's own company, auto-provisioned on first access (ADR-016). */
const ownMember = async (req: Request) => {
  const current = actor(req);

  return service.getOrCreateOwnMember(current.id, current);
};

/**
 * Replace the logo's storage key with the URL a browser can actually load.
 *
 * `serialise` drops `logo_path` for the same reason it drops `file_path` — it is
 * internal layout — so the record would otherwise carry no sign that a logo
 * exists at all, and the profile screen could not show the member their own mark.
 */
const withLogoUrl = (record: { id?: bigint; logo_path?: string | null }): unknown => {
  const base = serialise(record) as Record<string, unknown>;

  base.logo_url = record.logo_path && record.id ? logo.logoUrl(record.id) : null;

  return base;
};

/* --- member: profile ------------------------------------------------------- */

export const getOwnProfile = handler(async (req, res) => {
  const current = actor(req);
  const data = await service.getOwnProfile(current.id, current);

  handleApiResponse(res, { responseType: RES_STATUS.GET, data: withLogoUrl(data) });
});

export const updateOwnProfile = handler(async (req, res) => {
  const member = await ownMember(req);
  const updated = await service.updateOwnProfile(member.id, req.body as never, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.profileUpdated',
    data: serialise(updated),
  });
});

export const requestProfileChange = handler(async (req, res) => {
  const member = await ownMember(req);
  const created = await service.requestProfileChange(member.id, req.body as never, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'member.changeRequested',
    data: serialise(created),
  });
});

export const listOwnChangeRequests = handler(async (req, res) => {
  const member = await ownMember(req);
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await service.listOwnChangeRequests(member.id)),
  });
});

/* --- member: contacts and addresses ---------------------------------------- */

export const listContacts = handler(async (req, res) => {
  const member = await ownMember(req);
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await service.listContacts(member.id)),
  });
});

export const addContact = handler(async (req, res) => {
  const member = await ownMember(req);
  const created = await service.addContact(member.id, req.body as never, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'member.contactAdded',
    data: serialise(created),
  });
});

export const updateContact = handler(async (req, res) => {
  const member = await ownMember(req);
  const updated = await service.updateContact(
    member.id,
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.contactUpdated',
    data: serialise(updated),
  });
});

export const removeContact = handler(async (req, res) => {
  const member = await ownMember(req);
  const id = BigInt(req.params.id as string);
  await service.removeContact(member.id, id, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'member.contactRemoved',
    data: { id: id.toString() },
  });
});

export const listAddresses = handler(async (req, res) => {
  const member = await ownMember(req);
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await service.listAddresses(member.id)),
  });
});

export const addAddress = handler(async (req, res) => {
  const member = await ownMember(req);
  const created = await service.addAddress(member.id, req.body as never, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'member.addressAdded',
    data: serialise(created),
  });
});

export const updateAddress = handler(async (req, res) => {
  const member = await ownMember(req);
  const updated = await service.updateAddress(
    member.id,
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.addressUpdated',
    data: serialise(updated),
  });
});

export const removeAddress = handler(async (req, res) => {
  const member = await ownMember(req);
  const id = BigInt(req.params.id as string);
  await service.removeAddress(member.id, id, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'member.addressRemoved',
    data: { id: id.toString() },
  });
});

/* --- member: documents ----------------------------------------------------- */

export const getOwnChecklist = handler(async (req, res) => {
  const member = await ownMember(req);
  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(await documentService.checklistForMember(member.id)),
  });
});

export const uploadOwnDocument = handler(async (req, res) => {
  const member = await ownMember(req);
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

  /*
    The face is optional and advisory. A single-sided type ignores it; a two-sided
    one defaults to the front, and a PDF is recorded as covering both. The service
    decides — see `sideForUpload`.
  */
  const rawSide = (req.body as { side?: unknown }).side;
  const side = rawSide === 'BACK' || rawSide === 'FRONT' ? rawSide : undefined;

  const created = await documentService.upload(
    {
      memberId: member.id,
      documentTypeCode: code,
      originalName: file.originalname,
      buffer: file.buffer,
      declaredMime: file.mimetype,
      ...(side ? { requestedSide: side } : {}),
    },
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.CREATE,
    messageKey: 'document.uploaded',
    data: serialise(created),
  });
});

export const removeOwnDocument = handler(async (req, res) => {
  const member = await ownMember(req);
  const id = BigInt(req.params.id as string);
  await documentService.removeOwnDocument(member.id, id, actor(req));
  handleApiResponse(res, {
    responseType: RES_STATUS.DELETE,
    messageKey: 'document.removed',
    data: { id: id.toString() },
  });
});

/**
 * Stream a document to whoever is entitled to it.
 *
 * Shared by both audiences: the service decides entitlement, and a stranger gets
 * 404 rather than 403 so ids cannot be probed.
 */
export const downloadDocument = handler(async (req, res) => {
  const current = actor(req);
  const isAdmin = req.actor?.type === 'ADMIN';
  const memberId = isAdmin ? null : (await ownMember(req)).id;

  const file = await documentService.openForDownload(
    BigInt(req.params.id as string),
    { memberId, isAdmin },
    current,
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

/* --- admin ----------------------------------------------------------------- */

export const listMembers = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listMembers>[0];
  const result = await service.listMembers(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(result.rows),
    pagination: { page: query.page, limit: query.limit, total: result.total },
  });
});

export const getMemberDetail = handler(async (req, res) => {
  const data = await service.getMemberDetail(BigInt(req.params.id as string));
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(data) });
});

export const listInvoicesAdmin = handler(async (req, res) => {
  const query = req.query as unknown as Parameters<typeof service.listInvoicesAdmin>[0];
  const result = await service.listInvoicesAdmin(query);

  handleApiResponse(res, {
    responseType: RES_STATUS.GET,
    data: serialise(result.rows),
    pagination: { page: query.page, limit: query.limit, total: result.total },
  });
});

export const adminUpdateMember = handler(async (req, res) => {
  const updated = await service.adminUpdateMember(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.updated',
    data: serialise(updated),
  });
});

export const changeCategory = handler(async (req, res) => {
  const updated = await service.changeCategory(
    BigInt(req.params.id as string),
    req.body as never,
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.categoryChanged',
    data: serialise(updated),
  });
});

const statusHandler = (target: MemberStatus, messageKey: string) =>
  handler(async (req, res) => {
    const { reason } = req.body as { reason: string };
    const updated = await service.changeStatus(
      BigInt(req.params.id as string),
      target,
      reason,
      actor(req),
    );

    handleApiResponse(res, {
      responseType: RES_STATUS.ACTION,
      messageKey,
      data: serialise(updated),
    });
  });

export const suspendMember = statusHandler(MemberStatus.SUSPENDED, 'member.suspended');
export const reactivateMember = statusHandler(MemberStatus.ACTIVE, 'member.reactivated');
export const terminateMember = statusHandler(MemberStatus.TERMINATED, 'member.terminated');

export const recordInvoicePayment = handler(async (req, res) => {
  const updated = await service.recordInvoicePayment(
    BigInt(req.params.id as string),
    BigInt(req.params.invoiceId as string),
    actor(req),
  );
  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'member.invoicePaid',
    data: serialise(updated),
  });
});

export const payOwnInvoice = handler(async (req, res) => {
  const member = await ownMember(req);
  const updated = await service.payOwnInvoice(
    member.id,
    BigInt(req.params.invoiceId as string),
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.ACTION,
    messageKey: 'member.invoicePaid',
    data: serialise(updated),
  });
});

/**
 * Shared by both audiences, same shape as `downloadDocument`: the service
 * decides entitlement (owner or admin) and answers 404 to everyone else, so
 * an id cannot be used to probe for someone else's invoice.
 */
const streamPdf = (res: Response, file: { stream: NodeJS.ReadableStream; filename: string }) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename.replace(/["\r\n]/g, '')}"`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  file.stream.pipe(res);
};

export const downloadInvoicePdf = handler(async (req, res) => {
  const isAdmin = req.actor?.type === 'ADMIN';
  const memberId = isAdmin ? null : (await ownMember(req)).id;
  const file = await service.getInvoicePdf(BigInt(req.params.invoiceId as string), {
    memberId,
    isAdmin,
  });

  streamPdf(res, file);
});

export const downloadReceiptPdf = handler(async (req, res) => {
  const isAdmin = req.actor?.type === 'ADMIN';
  const memberId = isAdmin ? null : (await ownMember(req)).id;
  const file = await service.getReceiptPdf(BigInt(req.params.invoiceId as string), {
    memberId,
    isAdmin,
  });

  streamPdf(res, file);
});

export const listMemberDocuments = handler(async (req, res) => {
  const data = await documentService.listForMemberAsAdmin(BigInt(req.params.id as string));
  handleApiResponse(res, { responseType: RES_STATUS.GET, data: serialise(data) });
});

export const verifyDocument = handler(async (req, res) => {
  const body = req.body as { status: 'VERIFIED' | 'REJECTED'; remarks?: string };
  const updated = await documentService.verify(
    BigInt(req.params.id as string),
    { status: body.status, remarks: body.remarks },
    actor(req),
  );

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: body.status === 'VERIFIED' ? 'document.verified' : 'document.rejected',
    data: serialise(updated),
  });
});

/* --- member: company logo -------------------------------------------------- */

/**
 * `POST /members/me/logo` — the member's own mark, shown on the public site.
 *
 * Multipart, so the body is never encrypted (api-conventions.md §2). The bytes
 * are sniffed in the service before anything is stored; nothing here trusts the
 * filename or the browser's Content-Type.
 */
export const uploadOwnLogo = handler(async (req, res) => {
  const member = await ownMember(req);
  const file = req.file;

  if (!file) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'member.logoMissingFile',
    });
  }

  const result = await logo.putOwnLogo(member.id, file, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.logoUpdated',
    data: result,
  });
});

export const deleteOwnLogo = handler(async (req, res) => {
  const member = await ownMember(req);
  const result = await logo.clearOwnLogo(member.id, actor(req));

  handleApiResponse(res, {
    responseType: RES_STATUS.UPDATE,
    messageKey: 'member.logoRemoved',
    data: result,
  });
});

/**
 * `GET /public/members/:id/logo` — no session.
 *
 * Every rule that decides whether these bytes may be seen lives in the service's
 * WHERE clause: live, ACTIVE, and listed in the directory by the member's own
 * choice. A member who fails any of them answers 404, identically to an id that
 * was never issued.
 */
export const serveMemberLogo = handler(async (req, res) => {
  const raw = req.params.id ?? '';

  if (!/^\d+$/.test(raw)) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.logoNotFound' });
  }

  const file = await logo.openPublicLogo(BigInt(raw));
  const etag = `"${file.key}"`;

  res.setHeader('ETag', etag);
  /*
    `no-cache` is "keep it, but ask every time", not "do not store". A member who
    has just left the directory must stop being served from a stranger's disk
    cache; revalidation is cheap, because the ETag makes the usual answer a 304.
  */
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', file.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();

    return;
  }

  file.stream.pipe(res);
});
