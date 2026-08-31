import { ACTOR_TYPES, AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { sniffMime } from '@helpers/fileSignature';
import { buildStorageKey, getStorage } from '@helpers/storage';
import { AppError } from '@utils/appError';

/**
 * The member's company logo.
 *
 * Stored through the storage adapter like every other uploaded file, and served
 * back through an endpoint rather than from a public folder — the same choice
 * news covers make. A public folder cannot express "public only while this
 * member is active and has consented to be listed", and the moment one member
 * hides from the directory a guessable path is a leak.
 *
 * SVG is deliberately not accepted. An SVG is a script container, and this file
 * is rendered on the association's own front page.
 */

/** Sniffed type to the extension this server writes. Never the upload's own. */
export const MEMBER_LOGO_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** A logo is a small mark, not a photograph. Two megabytes is already generous. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export interface UploadedLogo {
  buffer: Buffer;
  originalname: string;
}

interface Actor {
  id: bigint | number;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

const notFound = (): AppError =>
  new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'member.logoNotFound' });

/** Where a browser fetches this member's logo. The endpoint re-checks the rules. */
/**
 * Where a member's own logo loads from.
 *
 * Authenticated, not public. The public variant was disabled on 2026-08-31 by
 * decision D1: a guessable public logo URL discloses that a named company is a
 * member of this association, which the members-only directory refuses to say.
 *
 * `/me/` rather than `/:id/` on purpose — this URL is only ever handed to the
 * member it belongs to, so it carries no id for anyone to iterate. Another
 * member's logo is served by the directory, behind the directory's own gate.
 */
export const logoUrl = (): string => `/api/v1/members/me/logo`;

/**
 * The Content-Type for a stored logo, from the key's extension.
 *
 * Safe because the extension was written below from sniffed bytes, not copied
 * from an upload. Anything unrecognised is refused rather than guessed —
 * serving bytes under a type nobody verified is how an image endpoint becomes
 * an HTML endpoint.
 */
export const logoMimeForKey = (key: string): string | null => {
  const match = /\.([a-z0-9]+)$/.exec(key);
  const extension = match ? `.${match[1]}` : '';
  const found = Object.entries(MEMBER_LOGO_MIME).find(([, ext]) => ext === extension);

  return found ? found[0] : null;
};

/** Best-effort delete. A key that is already gone is the outcome we wanted. */
const removeFile = async (key: string | null | undefined): Promise<void> => {
  if (!key) return;

  try {
    await getStorage().delete(key);
  } catch {
    // The row no longer points at it either way.
  }
};

/**
 * Store a new logo and point the member row at it.
 *
 * Replacing overwrites: unlike a KYC document, a logo carries no evidentiary
 * weight, so there is nothing to keep a version history of and the old file is
 * deleted once the row no longer references it.
 */
export const putOwnLogo = async (memberId: bigint, file: UploadedLogo, actor: Actor) => {
  if (file.buffer.byteLength > LOGO_MAX_BYTES) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'member.logoTooLarge',
      details: { maxBytes: LOGO_MAX_BYTES },
    });
  }

  const mime = sniffMime(file.buffer);
  const extension = mime ? MEMBER_LOGO_MIME[mime] : undefined;

  if (!mime || !extension) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'member.logoUnsupportedType',
      details: { allowed: Object.keys(MEMBER_LOGO_MIME) },
    });
  }

  const existing = await prisma.member.findFirst({
    where: { id: memberId, deletedAt: null },
    select: { id: true, logo_path: true },
  });

  if (!existing) throw notFound();

  const stored = await getStorage().put(
    buildStorageKey(['members', String(memberId)], `logo${extension}`),
    file.buffer,
    { mime, size: file.buffer.byteLength },
  );

  const updated = await prisma.$transaction(async (tx: Db) => {
    const row = await tx.member.update({
      where: { id: memberId },
      data: { logo_path: stored.key },
      select: { id: true, logo_path: true },
    });

    await writeAudit(tx, {
      actorType: ACTOR_TYPES.MEMBER,
      actorId: actor.id,
      action: AUDIT_ACTIONS.MEMBER_PROFILE_UPDATED,
      entityName: 'Member',
      entityId: memberId,
      before: { logo: existing.logo_path ? 'set' : 'none' },
      after: { logo: 'set' },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });

    return row;
  });

  // Only once the row no longer points at it.
  if (existing.logo_path && existing.logo_path !== stored.key) {
    await removeFile(existing.logo_path);
  }

  return { logo_url: updated.logo_path ? logoUrl() : null };
};

export const clearOwnLogo = async (memberId: bigint, actor: Actor) => {
  const existing = await prisma.member.findFirst({
    where: { id: memberId, deletedAt: null },
    select: { id: true, logo_path: true },
  });

  if (!existing) throw notFound();
  if (!existing.logo_path) return { logo_url: null };

  await prisma.$transaction(async (tx: Db) => {
    await tx.member.update({ where: { id: memberId }, data: { logo_path: null } });

    await writeAudit(tx, {
      actorType: ACTOR_TYPES.MEMBER,
      actorId: actor.id,
      action: AUDIT_ACTIONS.MEMBER_PROFILE_UPDATED,
      entityName: 'Member',
      entityId: memberId,
      before: { logo: 'set' },
      after: { logo: 'none' },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      requestId: actor.requestId ?? null,
    });
  });

  await removeFile(existing.logo_path);

  return { logo_url: null };
};

/**
 * Open a logo for the public endpoint.
 *
 * The visibility rules are applied here, in the same query that finds the row —
 * an ACTIVE member who has switched themselves out of the directory answers 404
 * exactly like one that never existed, because a 403 would confirm they are a
 * member.
 */
/**
 * The caller's own logo.
 *
 * Deliberately no `status` or `directory_visible` condition: a member must be
 * able to see the mark they uploaded whatever their membership state, and a
 * company that has opted out of the directory has not opted out of its own
 * profile page.
 */
export const openOwnLogo = async (memberId: bigint) => {
  const member = await prisma.member.findFirst({
    where: { id: memberId, deletedAt: null, logo_path: { not: null } },
    select: { logo_path: true },
  });

  if (!member?.logo_path) throw notFound();

  const mime = logoMimeForKey(member.logo_path);

  if (!mime) throw notFound();

  const store = getStorage();

  if (!(await store.exists(member.logo_path))) throw notFound();

  return { stream: await store.getStream(member.logo_path), mime, key: member.logo_path };
};

export const openPublicLogo = async (memberId: bigint) => {
  const member = await prisma.member.findFirst({
    where: {
      id: memberId,
      deletedAt: null,
      status: 'ACTIVE',
      directory_visible: true,
      logo_path: { not: null },
    },
    select: { logo_path: true },
  });

  if (!member?.logo_path) throw notFound();

  const mime = logoMimeForKey(member.logo_path);

  if (!mime) throw notFound();

  const store = getStorage();

  if (!(await store.exists(member.logo_path))) throw notFound();

  return { stream: await store.getStream(member.logo_path), mime, key: member.logo_path };
};
