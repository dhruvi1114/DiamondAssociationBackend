import { SettingValueType } from '@prisma/client';
import path from 'path';
import type { Readable } from 'stream';

import { AUDIT_ACTIONS } from '@constant/audit.constant';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { writeAudit } from '@helpers/audit';
import { sniffMime } from '@helpers/fileSignature';
import { getSetting, invalidateSetting, SETTING_KEYS } from '@helpers/settings';
import { buildStorageKey, getStorage } from '@helpers/storage';
import { logger } from '@logger/logger';
import { AppError } from '@utils/appError';

/**
 * The association's logo and logo mark.
 *
 * These are the one pair of settings whose value is not typed but uploaded, so
 * they get their own service rather than a special case inside the batch save.
 * The stored value is a storage key; the bytes live wherever the storage adapter
 * puts them, exactly like a KYC document.
 *
 * They are also the one pair that has to be readable **without a session**: the
 * logo appears on the login screen and at the head of an invoice, neither of
 * which has an authenticated user to check. That is why `readBranding` below
 * takes a slot name and not a key — the caller may choose which of the two
 * images it wants, and nothing else. A public endpoint that accepted a storage
 * key would be an unauthenticated reader for every file the platform holds.
 */

export const BRANDING_SLOTS = {
  logo: SETTING_KEYS.ORG_LOGO,
  'logo-mark': SETTING_KEYS.ORG_LOGO_MARK,
  /*
    The authorised signature printed on an invoice or receipt. An uploaded
    image for the same reason the logo is one: it is a scan of something signed
    on paper, and a typed name is not a signature.
  */
  signature: SETTING_KEYS.ORG_SIGNATURE,
} as const;

export type BrandingSlot = keyof typeof BRANDING_SLOTS;

export const isBrandingSlot = (value: string): value is BrandingSlot => value in BRANDING_SLOTS;

/**
 * Formats a browser renders and this codebase can identify from its bytes.
 *
 * SVG is deliberately absent, for the reason the document types carry the same
 * exclusion: an SVG is a script container, and this one is served to every
 * visitor of the login page. There is no version of "trusted uploader" that
 * makes shipping arbitrary markup to logged-out browsers a good idea.
 */
const ALLOWED: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** A logo is a few dozen KB. A megabyte is already generous; two is the hard stop. */
const MAX_BYTES = 2 * 1024 * 1024;

interface Actor {
  id: bigint;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface BrandingFile {
  stream: Readable;
  mime: string;
  key: string;
}

/**
 * Slots that are printed on a generated document.
 *
 * `logo-mark` is not one: it is the favicon and the collapsed sidebar, and
 * neither is a PDF.
 */
const PRINTED_SLOTS: BrandingSlot[] = ['logo', 'signature'];

/**
 * Throw away every cached invoice and receipt PDF.
 *
 * A rendered PDF is stored on the row and served again on the next download, so
 * without this an association that uploads a signature keeps handing out the
 * documents it generated before it had one — the setting changes and nothing
 * visible does, which reads as the upload having failed.
 *
 * Only the pointer is cleared. The old file is left in storage rather than
 * chased down one row at a time: a document somebody may already be holding a
 * link to is not worth deleting to save the disk, and the next download writes
 * a fresh key anyway.
 */
const dropCachedDocuments = async (slot: BrandingSlot) => {
  if (!PRINTED_SLOTS.includes(slot)) return;

  const [invoices, receipts] = await prisma.$transaction([
    prisma.invoice.updateMany({ where: { pdf_path: { not: null } }, data: { pdf_path: null } }),
    prisma.receipt.updateMany({ where: { pdf_path: { not: null } }, data: { pdf_path: null } }),
  ]);

  logger.info('branding.cachedDocumentsDropped', {
    slot,
    invoices: invoices.count,
    receipts: receipts.count,
  });
};

/**
 * Replace the image in a slot.
 *
 * Order matters: store the new file, point the setting at it, and only then
 * delete the old one. Deleting first would leave the login page with a broken
 * image for as long as the upload took, and leave it broken permanently if the
 * upload then failed.
 */
export const putBranding = async (
  slot: BrandingSlot,
  file: { buffer: Buffer; originalname: string },
  actor: Actor,
) => {
  const key = BRANDING_SLOTS[slot];

  if (file.buffer.byteLength > MAX_BYTES) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'settings.brandingTooLarge',
      details: { maxBytes: MAX_BYTES },
    });
  }

  // The bytes, not the Content-Type the upload claimed — that header is written
  // by the client and means nothing (file-storage.md §3).
  const mime = sniffMime(file.buffer);
  const extension = mime ? ALLOWED[mime] : undefined;

  if (!mime || !extension) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'settings.brandingUnsupportedType',
      details: { allowed: Object.keys(ALLOWED) },
    });
  }

  const previous = (await getSetting(key)) ?? '';

  /*
    The extension comes from the sniffed type, never from the uploaded filename.
    That is what lets the public endpoint below derive a Content-Type from the
    key alone: the extension is something this server decided, so it cannot
    disagree with the bytes.
  */
  const stored = await getStorage().put(
    buildStorageKey(['branding', slot], `${slot}${extension}`),
    file.buffer,
    { mime, size: file.buffer.byteLength },
  );

  // Row and audit together: a swap nobody can attribute is worse than no swap.
  await prisma.$transaction(async (tx) => {
    await tx.systemSetting.update({
      where: { key },
      data: { value: stored.key, value_type: SettingValueType.STRING },
    });

    await writeAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action: AUDIT_ACTIONS.SETTING_UPDATED,
      entityName: 'SystemSettings',
      before: { key, value: previous },
      after: { key, value: stored.key, mime, size: stored.size },
    });
  });

  invalidateSetting(key);

  if (previous && previous !== stored.key) {
    // Best effort. An orphaned file costs disk; a failed delete that rolled back
    // the swap would cost the admin their new logo.
    await getStorage()
      .delete(previous)
      .catch((error: unknown) => {
        logger.warn('branding.staleFileNotRemoved', {
          key: previous,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  }

  await dropCachedDocuments(slot);

  return { key, value: stored.key, mime, size: stored.size };
};

/** Point the slot at nothing, and remove the file it pointed at. */
export const clearBranding = async (slot: BrandingSlot, actor: Actor) => {
  const key = BRANDING_SLOTS[slot];
  const previous = (await getSetting(key)) ?? '';

  if (!previous) return { key, value: '' };

  await prisma.$transaction(async (tx) => {
    await tx.systemSetting.update({ where: { key }, data: { value: '' } });

    await writeAudit(tx, {
      actorType: 'ADMIN',
      actorId: actor.id,
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      action: AUDIT_ACTIONS.SETTING_UPDATED,
      entityName: 'SystemSettings',
      before: { key, value: previous },
      after: { key, value: '' },
    });
  });

  invalidateSetting(key);

  await getStorage()
    .delete(previous)
    .catch(() => undefined);

  await dropCachedDocuments(slot);

  return { key, value: '' };
};

/**
 * Open the image in a slot for streaming to anyone.
 *
 * The only unauthenticated read path into storage in the platform, and it is
 * narrow by construction: the caller names a slot, this reads the key out of
 * SystemSettings, and nothing the caller sends ever reaches the storage
 * adapter. Two images are reachable, whatever the request says.
 */
export const readBranding = async (slot: BrandingSlot): Promise<BrandingFile> => {
  const storageKey = (await getSetting(BRANDING_SLOTS[slot]))?.trim();

  if (!storageKey) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'settings.brandingNotSet' });
  }

  const extension = path.extname(storageKey).toLowerCase();
  const mime = Object.keys(ALLOWED).find((type) => ALLOWED[type] === extension);

  if (!mime) {
    // Only reachable if the row was written by something other than `putBranding`.
    logger.error('branding.unknownExtension', { slot, extension });

    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'settings.brandingNotSet' });
  }

  return { stream: await getStorage().getStream(storageKey), mime, key: storageKey };
};
