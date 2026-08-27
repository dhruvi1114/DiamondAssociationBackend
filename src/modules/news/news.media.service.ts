import type { Readable } from 'stream';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { prisma } from '@db/prisma';
import type { Db } from '@db/prisma';
import { sniffMime } from '@helpers/fileSignature';
import { uuidv4 } from '@helpers/random';
import { buildStorageKey, getStorage } from '@helpers/storage';
import { logger } from '@logger/logger';
import {
  ATTACHMENT_MAX_BYTES,
  COVER_MAX_BYTES,
  INLINE_IMAGE_MAX_BYTES,
  NEWS_IMAGE_MIME,
} from '@modules/news/news.constants';
import { AppError } from '@utils/appError';

/**
 * Files belonging to a news article: the cover, the pictures inside the body,
 * and the one attached PDF.
 *
 * None of them are web-served. Everything goes through the storage adapter, and
 * every read goes through a streaming endpoint that re-checks the article's
 * status and visibility first — so a members-only cover is not reachable by
 * guessing a path, and a draft's images are not reachable at all.
 *
 * That is a deliberate departure from "put public images in a public folder".
 * A public folder cannot express "public once this article is published", and
 * the moment one member-only article exists, a guessable path is a leak.
 */

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}

const tooLarge = (maxBytes: number): AppError =>
  new AppError({
    errorType: ERROR_TYPES.INVALID_REQUEST,
    messageKey: 'news.fileTooLarge',
    details: { maxBytes },
  });

const unsupported = (allowed: string[]): AppError =>
  new AppError({
    errorType: ERROR_TYPES.INVALID_REQUEST,
    messageKey: 'news.unsupportedFileType',
    details: { allowed },
  });

/**
 * Check the bytes and store them.
 *
 * The extension is derived from the SNIFFED type, never from the uploaded
 * filename — which is what lets the streaming endpoint below trust a key's
 * extension: it is something this server decided, so it cannot disagree with
 * the content.
 */
const storeImage = async (
  file: UploadedFile,
  articleId: bigint,
  maxBytes: number,
  prefix: string,
) => {
  if (file.buffer.byteLength > maxBytes) throw tooLarge(maxBytes);

  const mime = sniffMime(file.buffer);
  const extension = mime ? NEWS_IMAGE_MIME[mime] : undefined;

  if (!mime || !extension) throw unsupported(Object.keys(NEWS_IMAGE_MIME));

  const stored = await getStorage().put(
    buildStorageKey(['news', String(articleId)], `${prefix}${extension}`),
    file.buffer,
    { mime, size: file.buffer.byteLength },
  );

  return { ...stored, mime };
};

/** Store a cover image and return its key. The caller writes it to the row. */
export const storeCover = async (articleId: bigint, file: UploadedFile) =>
  storeImage(file, articleId, COVER_MAX_BYTES, 'cover');

/** Store one picture dropped into the body, and record the row that owns it. */
export const storeInlineImage = async (
  db: Db,
  articleId: bigint,
  file: UploadedFile,
  adminId: bigint,
) => {
  const stored = await storeImage(file, articleId, INLINE_IMAGE_MAX_BYTES, 'inline');

  return db.newsArticleImage.create({
    data: {
      article_id: articleId,
      // The URL written into the body. Random, not sequential — see the column comment.
      public_id: uuidv4(),
      file_path: stored.key,
      original_name: file.originalname.slice(0, 255),
      mime_type: stored.mime,
      size_bytes: BigInt(stored.size),
      checksum_sha256: stored.checksum,
      created_by_admin_id: adminId,
    },
  });
};

/** Store one attached PDF. Only a PDF: the button offers a document, not a file. */
export const storeAttachment = async (articleId: bigint, file: UploadedFile) => {
  if (file.buffer.byteLength > ATTACHMENT_MAX_BYTES) throw tooLarge(ATTACHMENT_MAX_BYTES);

  const mime = sniffMime(file.buffer);

  if (mime !== 'application/pdf') throw unsupported(['application/pdf']);

  const stored = await getStorage().put(
    buildStorageKey(['news', String(articleId)], 'attachment.pdf'),
    file.buffer,
    { mime, size: file.buffer.byteLength },
  );

  return { ...stored, mime };
};

/**
 * Remove a stored file, best effort.
 *
 * A failure here is logged and swallowed on purpose. The row is the record of
 * what the article holds; an orphaned file wastes disk, while a failed delete
 * that rolls back a successful edit loses the association's work.
 */
export const removeFile = async (key: string | null | undefined): Promise<void> => {
  if (!key) return;

  try {
    await getStorage().delete(key);
  } catch (error) {
    logger.warn('news.fileDeleteFailed', { key, error: (error as Error).message });
  }
};

/** Every file an article owns — used when the article itself is removed. */
export const removeAllFilesFor = async (articleId: bigint): Promise<void> => {
  const article = await prisma.newsArticle.findUnique({
    where: { id: articleId },
    select: { cover_image_path: true },
  });
  const images = await prisma.newsArticleImage.findMany({
    where: { article_id: articleId },
    select: { file_path: true },
  });
  const attachments = await prisma.newsArticleAttachment.findMany({
    where: { article_id: articleId },
    select: { file_path: true },
  });

  await Promise.all([
    removeFile(article?.cover_image_path),
    ...images.map((image) => removeFile(image.file_path)),
    ...attachments.map((attachment) => removeFile(attachment.file_path)),
  ]);
};

export interface StreamedFile {
  stream: Readable;
  mime: string;
  filename?: string;
}

/** Open a stored key for streaming, or 404 when the bytes are gone. */
export const openFile = async (
  key: string,
  mime: string,
  filename?: string,
): Promise<StreamedFile> => {
  const storage = getStorage();

  if (!(await storage.exists(key))) {
    throw new AppError({ errorType: ERROR_TYPES.NOT_FOUND, messageKey: 'news.fileNotFound' });
  }

  return { stream: await storage.getStream(key), mime, filename };
};

/**
 * The Content-Type for a stored image, from the key's extension.
 *
 * Safe because the extension was written by `storeImage` from sniffed bytes, not
 * copied from an upload. Anything unrecognised is refused rather than guessed —
 * serving bytes under a type nobody verified is how an image endpoint becomes an
 * HTML endpoint.
 */
export const imageMimeForKey = (key: string): string | null => {
  const match = /\.([a-z0-9]+)$/.exec(key);
  const extension = match ? `.${match[1]}` : '';
  const found = Object.entries(NEWS_IMAGE_MIME).find(([, ext]) => ext === extension);

  return found ? found[0] : null;
};
