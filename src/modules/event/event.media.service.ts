import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import { sniffMime } from '@helpers/fileSignature';
import { buildStorageKey, getStorage } from '@helpers/storage';
import { logger } from '@logger/logger';
import { AppError } from '@utils/appError';

/**
 * The poster on an event.
 *
 * Not web-served. The bytes go through the storage adapter and every read goes
 * through an endpoint that re-checks the event's status and visibility first, so
 * a members-only event's poster is not reachable by guessing a path and a
 * draft's poster is not reachable at all — the same rule the news cover follows.
 */

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}

/**
 * Formats a browser renders and `@helpers/fileSignature` can identify from its
 * bytes. SVG is deliberately absent: it is a script container, and this image is
 * served to logged-out visitors.
 */
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** A poster is a portrait photograph. Five megabytes is already a generous original. */
export const BANNER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Check the bytes and store them.
 *
 * The extension comes from the SNIFFED type, never from the uploaded filename,
 * which is what lets the streaming endpoint trust a key's extension: it is
 * something this server decided, so it cannot disagree with the content.
 */
export const storeBanner = async (eventId: bigint, file: UploadedFile) => {
  if (file.buffer.byteLength > BANNER_MAX_BYTES) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'event.bannerTooLarge',
      replacements: { maxBytes: String(BANNER_MAX_BYTES) },
      details: { maxBytes: BANNER_MAX_BYTES },
    });
  }

  const mime = sniffMime(file.buffer);
  const extension = mime ? ALLOWED[mime] : undefined;

  if (!mime || !extension) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'event.bannerUnsupportedType',
      details: { allowed: Object.keys(ALLOWED) },
    });
  }

  const stored = await getStorage().put(
    buildStorageKey(['events', String(eventId)], `banner${extension}`),
    file.buffer,
    { mime, size: file.buffer.byteLength },
  );

  return { ...stored, mime };
};

/**
 * Remove a stored poster, best effort.
 *
 * A failure here is logged and swallowed: the row is the record of what the
 * event holds, and an orphaned file wastes disk where a failed delete that rolls
 * back a successful edit loses the association's work.
 */
export const removeBanner = async (key: string | null | undefined): Promise<void> => {
  if (!key) return;

  try {
    await getStorage().delete(key);
  } catch (error) {
    logger.warn('event.bannerDeleteFailed', { key, error: (error as Error).message });
  }
};

/**
 * The Content-Type for a stored poster, from the key's extension.
 *
 * Safe because the extension was written by `storeBanner` from sniffed bytes.
 * Anything unrecognised is refused rather than guessed — serving bytes under a
 * type nobody verified is how an image endpoint becomes an HTML endpoint.
 */
export const bannerMimeForKey = (key: string): string | null => {
  const match = /\.([a-z0-9]+)$/.exec(key);
  const extension = match ? `.${match[1]}` : '';
  const found = Object.entries(ALLOWED).find(([, ext]) => ext === extension);

  return found ? found[0] : null;
};

/** Open a stored poster for streaming, or 404 when the bytes are gone. */
export const openBanner = async (key: string) => {
  const mime = bannerMimeForKey(key);
  const storage = getStorage();

  if (!mime || !(await storage.exists(key))) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.bannerNotFound' });
  }

  return { stream: await storage.getStream(key), mime };
};

/** Set or replace the poster. New file first, then the row, then the old bytes. */
export const setBanner = async (eventId: bigint, file: UploadedFile, adminId: bigint) => {
  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { id: true, banner_path: true },
  });

  if (!event) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.notFound' });
  }

  const stored = await storeBanner(eventId, file);

  await prisma.event.update({
    where: { id: eventId },
    data: { banner_path: stored.key, updated_by_admin_id: adminId },
  });

  await removeBanner(event.banner_path);

  return stored;
};

/** Take the poster off an event. */
export const clearBanner = async (eventId: bigint, adminId: bigint) => {
  const event = await prisma.event.findFirst({
    where: { id: eventId, deletedAt: null },
    select: { id: true, banner_path: true },
  });

  if (!event) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'event.notFound' });
  }

  await prisma.event.update({
    where: { id: eventId },
    data: { banner_path: null, updated_by_admin_id: adminId },
  });

  await removeBanner(event.banner_path);
};
