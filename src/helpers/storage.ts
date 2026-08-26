import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { environment } from '@config/config';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { logger } from '@logger/logger';
import { AppError } from '@utils/appError';
import { uuidv4 } from '@helpers/random';

/**
 * Storage behind an adapter (ADR-017 / file-storage.md §1).
 *
 * Callers never touch `fs` or an SDK, so switching to S3 is one new class plus
 * `STORAGE_DRIVER=s3` — no change in any service. Everything the platform
 * stores goes through here: KYC documents, invoice PDFs, notice attachments.
 */
export interface StoragePutMeta {
  mime: string;
  size: number;
}

export interface StoragePutResult {
  key: string;
  checksum: string;
  size: number;
}

export interface StorageAdapter {
  readonly driver: 'local' | 's3';
  put(key: string, body: Buffer | Readable, meta: StoragePutMeta): Promise<StoragePutResult>;
  getStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Deploy gate: is the backing store writable right now? (`/health/ready`) */
  healthCheck(): Promise<boolean>;
}

/**
 * Build a storage key. The filename is ALWAYS a server-generated UUID; the
 * original name is a database column, never a path component
 * (file-storage.md §2). That defeats traversal, unicode-normalisation and
 * case-collision attacks in one move, because the attacker-controlled string
 * never reaches the filesystem.
 */
export const buildStorageKey = (segments: string[], originalName: string): string => {
  const extension = path
    .extname(originalName)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '');
  const safeSegments = segments.map((segment) =>
    String(segment)
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .slice(0, 64),
  );

  return [...safeSegments, `${uuidv4()}${extension}`].join('/');
};

const sha256 = (buffer: Buffer): string => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Local filesystem driver. `STORAGE_PATH` sits outside the repo and outside
 * every web root — nginx must have no `location` that can reach it, and there
 * is no static route to it in this app. The only way to read a private file is
 * the authorised streaming endpoint (file-storage.md §4).
 */
export class LocalStorageAdapter implements StorageAdapter {
  public readonly driver = 'local' as const;

  private readonly root: string;

  constructor(root: string = environment.storagePath) {
    this.root = path.resolve(root);
  }

  /**
   * Resolve a key to an absolute path and prove it is still inside the root.
   *
   * This is the containment assertion, and it is deliberately a hard failure
   * rather than a sanitisation: if a key ever escapes, the correct response is
   * to refuse, not to quietly rewrite it into something that looks safe.
   */
  private resolveKey(key: string): string {
    const resolved = path.resolve(this.root, key);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;

    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      logger.error('storage.pathEscape', { keyLength: key.length });

      throw new AppError({
        errorType: ERROR_TYPES.INVALID_REQUEST,
        messageKey: 'document.storageFailed',
        sourcePath: 'LocalStorageAdapter.resolveKey',
      });
    }

    return resolved;
  }

  async put(key: string, body: Buffer | Readable, meta: StoragePutMeta): Promise<StoragePutResult> {
    const target = this.resolveKey(key);

    await fsp.mkdir(path.dirname(target), { recursive: true });

    try {
      if (Buffer.isBuffer(body)) {
        await fsp.writeFile(target, body, { mode: 0o640 });

        return { key, checksum: sha256(body), size: body.byteLength };
      }

      const hash = crypto.createHash('sha256');
      let size = 0;

      body.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });

      await pipeline(body, fs.createWriteStream(target, { mode: 0o640 }));

      return { key, checksum: hash.digest('hex'), size: size || meta.size };
    } catch (error) {
      // A half-written file is worse than none: the checksum would not match
      // and a restore would silently hand back a corrupt document.
      await fsp.rm(target, { force: true }).catch(() => undefined);

      logger.error('storage.putFailed', {
        key,
        detail: error instanceof Error ? error.message : String(error),
      });

      throw new AppError({
        errorType: ERROR_TYPES.INTERNAL_ERROR,
        messageKey: 'document.storageFailed',
        cause: error,
      });
    }
  }

  async getStream(key: string): Promise<Readable> {
    const target = this.resolveKey(key);

    if (!(await this.exists(key))) {
      throw new AppError({
        errorType: ERROR_TYPES.NOT_FOUND,
        messageKey: 'document.notFound',
      });
    }

    return fs.createReadStream(target);
  }

  async delete(key: string): Promise<void> {
    await fsp.rm(this.resolveKey(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.resolveKey(key));

      return stat.isFile();
    } catch {
      return false;
    }
  }

  async healthCheck(): Promise<boolean> {
    const probe = path.join(this.root, '.write-probe');

    try {
      await fsp.mkdir(this.root, { recursive: true });
      await fsp.writeFile(probe, String(Date.now()), { mode: 0o600 });
      await fsp.rm(probe, { force: true });

      return true;
    } catch (error) {
      logger.error('storage.notWritable', {
        detail: error instanceof Error ? error.message : String(error),
      });

      return false;
    }
  }
}

let adapter: StorageAdapter | null = null;

/** The configured adapter. `s3` lands as one more class here plus env (OQ-10c). */
export const getStorage = (): StorageAdapter => {
  if (adapter) {
    return adapter;
  }

  if (environment.storageDriver === 's3') {
    throw new AppError({
      errorType: ERROR_TYPES.INTERNAL_ERROR,
      messageKey: 'document.storageFailed',
      sourcePath: 'getStorage: STORAGE_DRIVER=s3 is not implemented (OQ-10c, ADR-017)',
    });
  }

  adapter = new LocalStorageAdapter();

  return adapter;
};

export const storage = {
  get current(): StorageAdapter {
    return getStorage();
  },
};
