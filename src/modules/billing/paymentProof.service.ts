import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { sniffMime } from '@helpers/fileSignature';
import { buildStorageKey, getStorage } from '@helpers/storage';
import { logger } from '@logger/logger';
import { AppError } from '@utils/appError';

/**
 * The receipt a payer attaches to a payment claim.
 *
 * A claim without one is a number the association has to look up in its bank
 * portal before it can believe anything; with one, the person verifying sees
 * what the payer saw. The file is evidence, so it is stored the way evidence is
 * stored here — through the storage adapter, never on a public path, and read
 * back only through an endpoint that checks who is asking.
 *
 * Keyed by INVOICE rather than by booking. The claim table itself hangs off
 * `invoice_id`, and membership invoices are about to use this same flow, so a
 * key shaped around event registrations would need renaming the moment they do.
 */

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
}

/**
 * What a bank actually gives someone.
 *
 * A phone screenshot is a JPG or PNG; net banking hands out a PDF slip. WebP is
 * here because newer Android screenshots use it. SVG is deliberately absent —
 * it is a script container, and `@helpers/fileSignature` cannot identify one
 * from its bytes anyway.
 */
const ALLOWED: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/** A screenshot is well under this; the ceiling is here to stop an upload, not to size one. */
export const PROOF_MAX_BYTES = 5 * 1024 * 1024;

/** The mime a stored proof is served as, from the extension THIS server chose. */
export const proofMimeForKey = (key: string): string => {
  const found = Object.entries(ALLOWED).find(([, extension]) =>
    key.toLowerCase().endsWith(extension),
  );

  return found ? found[0] : 'application/octet-stream';
};

/**
 * Check the bytes and store them.
 *
 * The extension comes from the SNIFFED type, never from the uploaded filename.
 * That is what lets the download endpoint trust a key's extension later: it is
 * something this server decided, so it cannot disagree with the content — and a
 * `virus.exe` renamed to `receipt.pdf` is refused here rather than handed to
 * whoever opens it.
 */
export const storeProof = async (invoiceId: bigint, file: UploadedFile) => {
  if (file.buffer.byteLength === 0) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'billing.proofEmpty',
    });
  }

  if (file.buffer.byteLength > PROOF_MAX_BYTES) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'billing.proofTooLarge',
      replacements: { maxBytes: String(PROOF_MAX_BYTES) },
      details: { maxBytes: PROOF_MAX_BYTES },
    });
  }

  const mime = sniffMime(file.buffer);
  const extension = mime ? ALLOWED[mime] : undefined;

  if (!mime || !extension) {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'billing.proofUnsupportedType',
      details: { allowed: Object.keys(ALLOWED) },
    });
  }

  const stored = await getStorage().put(
    buildStorageKey(['invoices', String(invoiceId), 'proofs'], `proof${extension}`),
    file.buffer,
    { mime, size: file.buffer.byteLength },
  );

  return { ...stored, mime };
};

/**
 * Remove a stored proof, best effort.
 *
 * Called when the claim it belonged to could not be written. A failure here is
 * logged and swallowed: the row is the record of what happened, and an orphaned
 * file wastes disk where a throw would turn a storage hiccup into a lost claim.
 */
export const removeProof = async (key: string | null | undefined): Promise<void> => {
  if (!key) return;

  try {
    await getStorage().delete(key);
  } catch (error) {
    logger.warn('billing.proofDeleteFailed', { key, error: (error as Error).message });
  }
};
