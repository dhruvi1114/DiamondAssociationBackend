import { DocumentVerificationStatus, Prisma } from '@prisma/client';
import type { Readable } from 'node:stream';
import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma, type Db } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { matchesAllowedMime, sniffMime } from '@helpers/fileSignature';
import { buildStorageKey, storage } from '@helpers/storage';
import { logger } from '@logger/logger';
import {
  describeSide,
  type DocumentSideValue,
  requiredSides,
  sideForUpload,
} from '@modules/document/document.sides';
import {
  type ChecklistItem,
  checklistFor,
  findTypeForUpload,
} from '@modules/masters/masters.checklist';
import { AppError } from '@utils/appError';

/**
 * KYC document handling (M3).
 *
 * The validation order in `upload` is deliberate and is the whole security story
 * of this module (file-storage.md §3): authorise, then check the type exists,
 * then the size, then the **actual bytes**, then hash, then persist — and only
 * then does the file get a database row. A failure at any step leaves nothing
 * behind.
 */

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const notFound = (key: string): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: key });

/**
 * `replacements` fills the `{{placeholders}}` in the message; `details` carries
 * the machine-readable version for the UI. Passing only `details` renders
 * "larger than the  MB limit" — the number the member most needs, missing.
 */
const invalid = (
  key: string,
  options?: { replacements?: Record<string, string>; details?: Record<string, unknown> },
): AppError =>
  new AppError({
    errorType: ERROR_TYPES.VALIDATION_ERROR,
    messageKey: key,
    ...(options?.replacements ? { replacements: options.replacements } : {}),
    ...(options?.details ? { details: options.details } : {}),
  });

export interface UploadInput {
  memberId: bigint;
  documentTypeCode: string;
  originalName: string;
  buffer: Buffer;
  declaredMime: string;
  /** Which face this file is, for a two-sided type. Advisory — see `sideForUpload`. */
  requestedSide?: DocumentSideValue;
}

export const upload = async (input: UploadInput, actor: Actor) => {
  const documentType = await prisma.documentType.findFirst({
    where: { code: input.documentTypeCode, deletedAt: null, is_active: true },
  });
  if (!documentType) throw notFound('masters.documentTypeNotFound');

  const maxBytes = documentType.max_size_mb * 1024 * 1024;
  if (input.buffer.length > maxBytes) {
    // The limit is in the message: "too large" without a number is a guessing game.
    throw invalid('document.tooLarge', {
      replacements: { max_size_mb: String(documentType.max_size_mb) },
      details: { max_size_mb: documentType.max_size_mb, actual_bytes: input.buffer.length },
    });
  }

  if (input.buffer.length === 0) throw invalid('document.empty');

  // The bytes, not the header. A `.pdf` that is really HTML is stored XSS the
  // moment a reviewer opens it.
  if (!matchesAllowedMime(input.buffer, documentType.allowed_mime)) {
    throw invalid('document.unsupportedType', {
      replacements: { allowed: documentType.allowed_mime.join(', ') },
      details: {
        declared: input.declaredMime,
        detected: sniffMime(input.buffer) ?? 'unrecognised',
        allowed: documentType.allowed_mime,
      },
    });
  }

  const actualMime = sniffMime(input.buffer) as string;
  const side = sideForUpload(documentType.sides, input.requestedSide, actualMime);

  // Re-uploading supersedes rather than overwrites: an approver's decision has to
  // stay explainable by the file they actually saw (file-storage.md §5). Scoped to
  // the face, so replacing a back does not supersede an accepted front.
  const previous = await prisma.memberDocument.findFirst({
    where: {
      member_id: input.memberId,
      document_type_id: documentType.id,
      side,
      deletedAt: null,
    },
    orderBy: { version: 'desc' },
  });

  const key = buildStorageKey(
    ['members', input.memberId.toString(), 'kyc', documentType.code, side],
    input.originalName,
  );

  const stored = await storage.current.put(key, input.buffer, {
    mime: actualMime,
    size: input.buffer.length,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.memberDocument.create({
        data: {
          member_id: input.memberId,
          document_type_id: documentType.id,
          side,
          file_path: stored.key,
          original_name: input.originalName.slice(0, 255),
          mime_type: actualMime,
          size_bytes: BigInt(stored.size),
          checksum_sha256: stored.checksum,
          version: (previous?.version ?? 0) + 1,
          verification_status: DocumentVerificationStatus.PENDING,
        },
      });

      await writeAudit(tx, {
        actorType: 'MEMBER',
        actorId: actor.id,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
        action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
        entityName: 'MemberDocuments',
        entityId: created.id,
        after: {
          document_type: documentType.code,
          side,
          version: created.version,
          size_bytes: stored.size,
          checksum: stored.checksum,
        },
      });

      return created;
    });
  } catch (error) {
    // The row failed, so the file is an orphan. Remove it rather than leaving
    // bytes on disk that nothing references and no retention job knows about.
    await storage.current.delete(stored.key).catch((cleanupError: unknown) => {
      logger.error('document.orphanCleanupFailed', {
        key: stored.key,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });

    throw error;
  }
};

/** Every live document for a member, newest version of each type first. */
export const listForMember = (memberId: bigint) =>
  prisma.memberDocument.findMany({
    where: { member_id: memberId, deletedAt: null },
    orderBy: [{ document_type_id: 'asc' }, { version: 'desc' }],
    include: {
      document_type: {
        select: { id: true, code: true, name: true, is_required: true, sides: true },
      },
      verified_by: { select: { id: true, full_name: true } },
    },
  });

/**
 * The KYC checklist: every active document type, paired with the member's latest
 * upload for it. Built as one pass over both lists rather than a query per type.
 */
export const checklistForMember = async (memberId: bigint) => {
  const [memberTypes, documents] = await Promise.all([
    checklistFor('MEMBER'),
    listForMember(memberId),
  ]);

  /*
    The checklist is what the member OWES, plus whatever they already HOLD.

    Approval copies the application's verified KYC onto the member record, and
    those three types are configured `applies_to: APPLICATION` — so driving this
    list from the MEMBER checklist alone rendered a member who demonstrably had a
    verified GST certificate as "No documents uploaded". A file that exists is
    never invisible here, whatever surface its type is filed under; the
    association's own checklist still decides what is REQUIRED, which is what
    `completeness` below counts.
  */
  const listed = new Set(memberTypes.map((type) => type.id.toString()));
  const held = new Map<string, (typeof memberTypes)[number]>();
  for (const doc of documents) {
    const id = doc.document_type_id.toString();
    if (listed.has(id) || held.has(id)) continue;

    held.set(id, {
      id: doc.document_type_id,
      code: doc.document_type.code,
      name: doc.document_type.name,
      description: null,
      // Held-but-not-listed: the member is not asked for it again, so it cannot
      // count against completeness however the master has it flagged.
      is_required: false,
      sides: doc.document_type.sides,
      max_size_mb: 0,
      allowed_mime: [],
      // Sorted after everything the association actually asks for.
      display_order: Number.MAX_SAFE_INTEGER,
    });
  }

  const types = [...memberTypes, ...held.values()];

  /*
    Keyed on (type, face), not on type alone.

    A two-sided document has a newest front AND a newest back, and collapsing them
    to one entry would report a member as having supplied a document when only
    half of it is here.
  */
  const latest = new Map<string, (typeof documents)[number]>();
  for (const doc of documents) {
    const key = `${doc.document_type_id}:${doc.side}`;
    if (!latest.has(key)) latest.set(key, doc);
  }

  const items = types.flatMap((type) =>
    requiredSides(type.sides).map((side) => {
      // A COMBINED PDF stands in for both faces of a two-sided type.
      const document =
        latest.get(`${type.id}:${side}`) ?? latest.get(`${type.id}:COMBINED`) ?? null;

      return {
        document_type_id: type.id,
        code: type.code,
        name: type.name,
        description: type.description,
        is_required: type.is_required,
        sides: type.sides,
        side,
        label: describeSide(type.name, side),
        max_size_mb: type.max_size_mb,
        allowed_mime: type.allowed_mime,
        document,
      };
    }),
  );

  const required = items.filter((item) => item.is_required);
  const satisfied = required.filter(
    (item) => item.document && item.document.verification_status !== 'REJECTED',
  );

  return {
    items,
    completeness: {
      required_total: required.length,
      required_supplied: satisfied.length,
      // A member with no required types configured is not "100% complete" — it
      // means the federation has not published its checklist yet (OQ-9).
      configured: required.length > 0,
    },
  };
};

/**
 * Resolve a document for download.
 *
 * Anyone who is not the owner or a permitted admin gets `NOT_FOUND`, never
 * `FORBIDDEN`: a 403 confirms the id exists, which turns this endpoint into an
 * oracle for enumerating other members' documents (rbac.md §5).
 */
export const openForDownload = async (
  documentId: bigint,
  viewer: { memberId?: bigint | null; isAdmin: boolean },
  actor: Actor,
): Promise<{ stream: Readable; filename: string; mime: string; size: bigint }> => {
  const document = await prisma.memberDocument.findFirst({
    where: { id: documentId, deletedAt: null },
  });

  if (!document) throw notFound('document.notFound');

  const isOwner = viewer.memberId !== null && viewer.memberId === document.member_id;
  if (!isOwner && !viewer.isAdmin) throw notFound('document.notFound');

  const stream = await storage.current.getStream(document.file_path);

  await writeAudit(prisma, {
    actorType: viewer.isAdmin ? 'ADMIN' : 'MEMBER',
    actorId: actor.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
    action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
    entityName: 'MemberDocuments',
    entityId: document.id,
    after: { original_name: document.original_name },
  });

  return {
    stream,
    filename: document.original_name,
    mime: document.mime_type,
    size: document.size_bytes,
  };
};

/** A member may withdraw an upload nobody has looked at yet. */
export const removeOwnDocument = async (memberId: bigint, documentId: bigint, actor: Actor) => {
  const document = await prisma.memberDocument.findFirst({
    where: { id: documentId, member_id: memberId, deletedAt: null },
  });
  if (!document) throw notFound('document.notFound');

  if (document.verification_status === DocumentVerificationStatus.VERIFIED) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'document.verifiedImmutable',
    });
  }

  await prisma.$transaction(async (tx) => {
    // Soft delete only. The file stays until the retention job runs, because a
    // rejected-then-deleted document is still part of why an application was
    // returned (OQ-15 decides how long).
    await tx.memberDocument.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });

    await writeAudit(tx, {
      actorType: 'MEMBER',
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action: AUDIT_ACTIONS.DOCUMENT_DELETED,
      entityName: 'MemberDocuments',
      entityId: documentId,
      before: { original_name: document.original_name, version: document.version },
    });
  });
};

/* -------------------------------------------------------------------------- */
/* Admin verification                                                          */
/* -------------------------------------------------------------------------- */

export const listForMemberAsAdmin = (memberId: bigint) => listForMember(memberId);

export const verify = async (
  documentId: bigint,
  decision: { status: 'VERIFIED' | 'REJECTED'; remarks?: string | undefined },
  actor: Actor,
) => {
  const document = await prisma.memberDocument.findFirst({
    where: { id: documentId, deletedAt: null },
  });
  if (!document) throw notFound('document.notFound');

  // Mirrors the database CHECK. Both exist on purpose: the constraint is the
  // guarantee, this is the message the reviewer can act on.
  if (decision.status === 'REJECTED' && !decision.remarks?.trim()) {
    throw invalid('document.rejectionNeedsRemarks');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.memberDocument.update({
      where: { id: documentId },
      data: {
        verification_status: decision.status as DocumentVerificationStatus,
        verified_by_admin_id: actor.id,
        verified_at: new Date(),
        remarks: decision.remarks ?? null,
      },
    });

    await writeAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action:
        decision.status === 'VERIFIED'
          ? AUDIT_ACTIONS.DOCUMENT_VERIFIED
          : AUDIT_ACTIONS.DOCUMENT_REJECTED,
      entityName: 'MemberDocuments',
      entityId: documentId,
      before: { verification_status: document.verification_status },
      after: { verification_status: decision.status, remarks: decision.remarks ?? null },
    });

    return updated;
  });
};

export type DocumentListItem = Prisma.PromiseReturnType<typeof listForMember>[number];

/* -------------------------------------------------------------------------- */
/* Application evidence                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Shared validation for application uploads — bytes only, no persistence.
 *
 * Limits come from the document type row, not from a constant: the association
 * configures its own checklist from screen A-12 (M5), so a size ceiling raised in
 * the admin takes effect on the next upload with no deploy.
 *
 * Magic-byte sniffing is unchanged. A client-declared Content-Type is not
 * evidence (file-storage.md §3), and the closed MIME allowlist on the master
 * still means an admin cannot admit `image/svg+xml`.
 */
export const validateApplicationFileBuffer = async (
  documentTypeCode: string,
  buffer: Buffer,
  declaredMime: string,
  requestedSide?: DocumentSideValue,
): Promise<{ type: ChecklistItem; side: DocumentSideValue; actualMime: string }> => {
  const type = await findTypeForUpload(documentTypeCode);
  if (!type) throw notFound('masters.documentTypeNotFound');

  const maxBytes = type.max_size_mb * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw invalid('document.tooLarge', {
      replacements: { max_size_mb: String(type.max_size_mb) },
      details: { max_size_mb: type.max_size_mb, actual_bytes: buffer.length },
    });
  }

  if (buffer.length === 0) throw invalid('document.empty');

  if (!matchesAllowedMime(buffer, type.allowed_mime)) {
    throw invalid('document.unsupportedType', {
      replacements: { allowed: type.allowed_mime.join(', ') },
      details: {
        declared: declaredMime,
        detected: sniffMime(buffer) ?? 'unrecognised',
        allowed: type.allowed_mime,
      },
    });
  }

  const actualMime = sniffMime(buffer) as string;

  return { type, side: sideForUpload(type.sides, requestedSide, actualMime), actualMime };
};

export interface StoredApplicationFile {
  document_type_id: bigint;
  document_type_code: string;
  side: DocumentSideValue;
  file_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: bigint;
  checksum_sha256: string;
}

/** Persist bytes for an application document. Caller owns transaction rollback cleanup. */
export const storeApplicationFile = async (input: {
  applicationId: bigint;
  documentTypeCode: string;
  originalName: string;
  buffer: Buffer;
  declaredMime: string;
  requestedSide?: DocumentSideValue;
}): Promise<StoredApplicationFile> => {
  const { type, side, actualMime } = await validateApplicationFileBuffer(
    input.documentTypeCode,
    input.buffer,
    input.declaredMime,
    input.requestedSide,
  );

  // The face is part of the key: a two-sided type stores two files under one
  // application and one code, and they must not collide.
  const key = buildStorageKey(
    ['applications', input.applicationId.toString(), type.code, side],
    input.originalName,
  );

  const stored = await storage.current.put(key, input.buffer, {
    mime: actualMime,
    size: input.buffer.length,
  });

  return {
    document_type_id: type.id,
    document_type_code: type.code,
    side,
    file_path: stored.key,
    original_name: input.originalName.slice(0, 255),
    mime_type: actualMime,
    size_bytes: BigInt(stored.size),
    checksum_sha256: stored.checksum,
  };
};

export const createApplicationDocumentRow = async (
  tx: Db,
  input: {
    applicationId: bigint;
    stored: StoredApplicationFile;
    actor: Actor;
  },
) => {
  const created = await tx.applicationDocument.create({
    data: {
      application_id: input.applicationId,
      document_type_id: input.stored.document_type_id,
      side: input.stored.side,
      file_path: input.stored.file_path,
      original_name: input.stored.original_name,
      mime_type: input.stored.mime_type,
      size_bytes: input.stored.size_bytes,
      checksum_sha256: input.stored.checksum_sha256,
      version: 1,
      verification_status: DocumentVerificationStatus.PENDING,
    },
  });

  await writeAudit(tx, {
    actorType: 'MEMBER',
    actorId: input.actor.id,
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
    requestId: input.actor.requestId,
    action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
    entityName: 'ApplicationDocuments',
    entityId: created.id,
    after: {
      document_type: input.stored.document_type_code,
      side: input.stored.side,
      version: created.version,
      checksum: input.stored.checksum_sha256,
    },
  });

  return created;
};

/**
 * Upload against an application rather than the member record.
 *
 * Same validation chain as member KYC — the rules do not get weaker because the
 * company is not a member yet. Kept as a separate function rather than a flag on
 * `upload` because the two write to different tables with different lifecycles
 * (ADR-006): an application's evidence is frozen with the decision, a member's
 * is current.
 */
export const uploadApplicationDocument = async (
  input: Omit<UploadInput, 'memberId'> & {
    applicationId: bigint;
    requestedSide?: DocumentSideValue;
  },
  actor: Actor,
) => {
  const { type, side, actualMime } = await validateApplicationFileBuffer(
    input.documentTypeCode,
    input.buffer,
    input.declaredMime,
    input.requestedSide,
  );

  // Versioning is per face: replacing a rejected back must not supersede the
  // front that was already accepted.
  const previous = await prisma.applicationDocument.findFirst({
    where: {
      application_id: input.applicationId,
      document_type_id: type.id,
      side,
      deletedAt: null,
    },
    orderBy: { version: 'desc' },
  });

  const key = buildStorageKey(
    ['applications', input.applicationId.toString(), type.code, side],
    input.originalName,
  );

  const stored = await storage.current.put(key, input.buffer, {
    mime: actualMime,
    size: input.buffer.length,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.applicationDocument.create({
        data: {
          application_id: input.applicationId,
          document_type_id: type.id,
          side,
          file_path: stored.key,
          original_name: input.originalName.slice(0, 255),
          mime_type: actualMime,
          size_bytes: BigInt(stored.size),
          checksum_sha256: stored.checksum,
          version: (previous?.version ?? 0) + 1,
          verification_status: DocumentVerificationStatus.PENDING,
        },
      });

      /*
       * The replacement settles the debt the rejection recorded.
       *
       * The superseded row keeps its REJECTED status and its remarks — that is
       * the record of what the reviewer saw and said — but it is no longer
       * something the applicant owes, so the next rejection email must not
       * itemise it again.
       */
      if (previous?.requires_reupload) {
        await tx.applicationDocument.update({
          where: { id: previous.id },
          data: { requires_reupload: false },
        });
      }

      await writeAudit(tx, {
        actorType: 'MEMBER',
        actorId: actor.id,
        ip: actor.ip,
        userAgent: actor.userAgent,
        requestId: actor.requestId,
        action: AUDIT_ACTIONS.DOCUMENT_UPLOADED,
        entityName: 'ApplicationDocuments',
        entityId: created.id,
        after: {
          document_type: type.code,
          side,
          version: created.version,
          checksum: stored.checksum,
        },
      });

      return created;
    });
  } catch (error) {
    await storage.current.delete(stored.key).catch((cleanupError: unknown) => {
      logger.error('document.orphanCleanupFailed', {
        key: stored.key,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });

    throw error;
  }
};

/** Remove an application upload the reviewer has not accepted yet. */
export const removeApplicationDocument = async (
  applicationId: bigint,
  documentId: bigint,
  actor: Actor,
) => {
  const document = await prisma.applicationDocument.findFirst({
    where: { id: documentId, application_id: applicationId, deletedAt: null },
  });
  if (!document) throw notFound('document.notFound');

  if (document.verification_status === DocumentVerificationStatus.VERIFIED) {
    throw new AppError({
      errorType: ERROR_TYPES.CONFLICT,
      messageKey: 'document.verifiedImmutable',
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.applicationDocument.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });

    await writeAudit(tx, {
      actorType: 'MEMBER',
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action: AUDIT_ACTIONS.DOCUMENT_DELETED,
      entityName: 'ApplicationDocuments',
      entityId: documentId,
      before: { original_name: document.original_name, version: document.version },
    });
  });
};

/** Verify or reject a document attached to an application (review screen A-04). */
export const verifyApplicationDocument = async (
  documentId: bigint,
  decision: { status: 'VERIFIED' | 'REJECTED'; remarks?: string | undefined },
  actor: Actor,
) => {
  const document = await prisma.applicationDocument.findFirst({
    where: { id: documentId, deletedAt: null },
  });
  if (!document) throw notFound('document.notFound');

  if (decision.status === 'REJECTED' && !decision.remarks?.trim()) {
    throw invalid('document.rejectionNeedsRemarks');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.applicationDocument.update({
      where: { id: documentId },
      data: {
        verification_status: decision.status as DocumentVerificationStatus,
        verified_by_admin_id: actor.id,
        verified_at: new Date(),
        remarks: decision.remarks ?? null,
      },
    });

    await writeAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action:
        decision.status === 'VERIFIED'
          ? AUDIT_ACTIONS.DOCUMENT_VERIFIED
          : AUDIT_ACTIONS.DOCUMENT_REJECTED,
      entityName: 'ApplicationDocuments',
      entityId: documentId,
      before: { verification_status: document.verification_status },
      after: { verification_status: decision.status, remarks: decision.remarks ?? null },
    });

    return updated;
  });
};

/**
 * Stream an application document. Entitlement: the applicant who filed it, or an
 * admin who may view applications. Everyone else gets 404, never 403.
 */
export const openApplicationDocumentForDownload = async (
  applicationId: bigint,
  documentId: bigint,
  viewer: { userId?: bigint | null; isAdmin: boolean },
  actor: Actor,
): Promise<{ stream: Readable; filename: string; mime: string; size: bigint }> => {
  // Scoped to the application in the URL, not the document id alone. Application
  // and member document ids are separate sequences that overlap numerically, so a
  // route keyed on the bare id would let one id space address the other.
  const document = await prisma.applicationDocument.findFirst({
    where: { id: documentId, application_id: applicationId, deletedAt: null },
    include: { application: { select: { user_id: true } } },
  });

  if (!document) throw notFound('document.notFound');

  const isOwner = viewer.userId !== null && viewer.userId === document.application.user_id;
  if (!isOwner && !viewer.isAdmin) throw notFound('document.notFound');

  const stream = await storage.current.getStream(document.file_path);

  await writeAudit(prisma, {
    actorType: viewer.isAdmin ? 'ADMIN' : 'MEMBER',
    actorId: actor.id,
    ip: actor.ip,
    userAgent: actor.userAgent,
    requestId: actor.requestId,
    action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
    entityName: 'ApplicationDocuments',
    entityId: document.id,
    after: { original_name: document.original_name },
  });

  return {
    stream,
    filename: document.original_name,
    mime: document.mime_type,
    size: document.size_bytes,
  };
};
