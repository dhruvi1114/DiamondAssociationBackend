import CryptoJS from 'crypto-js';
import pako from 'pako';
import { environment } from '@config/config';
import { ERROR_TYPES } from '@constant/errorTypes.constant';
import { AppError } from '@utils/appError';
import { generateString } from '@helpers/random';

/**
 * Payload obfuscation, Elvee-identical (ADR-004).
 *
 *   encrypt: JSON.stringify → gzip → base64 → prefix 16 random chars
 *            → AES-256-CBC(key = TERIFF, iv = PLAN) → base64 (OpenSSL format)
 *   decrypt: exact reverse, dropping the 16-character prefix before ungzip.
 *
 * The byte format is shared verbatim with `customer/src/utils/enc-dec.ts`,
 * `admin/src/utils/enc-dec.ts` and the Sentinel crypto suite, so any change
 * here is a coordinated four-way release.
 *
 * This is NOT a confidentiality boundary. The browser holds the key, so it is
 * readable by anyone who opens the bundle (security.md §4). It raises the cost
 * of casual scraping; authn, authz and validation still run on every request.
 * The IV is fixed per environment — a known, accepted weakness (R-5).
 */

/**
 * UTF-8, NOT latin1/'binary'.
 *
 * This is the trap the scheme sets: gzip output contains bytes above 0x7F, and
 * `Buffer.from(str, 'binary')` encodes those differently from the default UTF-8
 * that the browsers' `btoa`/`atob` shims — and therefore the customer app, the
 * admin app and the Sentinel — produce. Each side still round-trips against
 * itself, so unit tests on either side pass while the integration boundary is
 * broken. Keep these two functions byte-identical to
 * `elvee-backend/src/helpers/encryption.ts` and `sarvadhi-sentinel/lib.js`.
 */
const universalBtoa = (input: string): string => Buffer.from(input).toString('base64');

const universalAtob = (input: string): string => Buffer.from(input, 'base64').toString();

/** Uint8Array → binary string → base64. Matches the frontend byte-for-byte. */
export const bufferToBase64 = (buf: Uint8Array): string => {
  const binaryString = Array.prototype.map
    .call(buf, (charCode: number) => String.fromCharCode(charCode))
    .join('');

  return universalBtoa(binaryString);
};

/** base64 → binary string → Uint8Array. Inverse of `bufferToBase64`. */
export const base64ToBuffer = (base64: string): Uint8Array => {
  const binaryString = universalAtob(base64);
  const buf = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    buf[index] = binaryString.charCodeAt(index);
  }

  return buf;
};

/** gzip + base64 + 16-character random prefix. The prefix is pure noise. */
export const compressData = (value: string): string => {
  const utf8 = new TextEncoder().encode(value);
  const compressed = bufferToBase64(pako.gzip(utf8));

  return generateString(16) + compressed;
};

/** Drops the 16-character prefix, then base64-decodes and ungzips. */
export const decompressData = (value: string): string => {
  const withoutPrefix = value.substring(16);
  const inflated = pako.ungzip(base64ToBuffer(withoutPrefix));

  return new TextDecoder('utf-8').decode(inflated);
};

const key = (): CryptoJS.lib.WordArray => CryptoJS.enc.Utf8.parse(environment.encryptionKey);
const iv = (): CryptoJS.lib.WordArray => CryptoJS.enc.Utf8.parse(environment.encryptionIv);

/**
 * Encrypt any JSON-serialisable value into the transport ciphertext.
 *
 * @throws AppError INTERNAL_ERROR — never leaks the underlying reason, which
 * would describe the key material.
 */
export const encrypt = (data: unknown): string => {
  try {
    const compressed = compressData(JSON.stringify(data ?? null));

    return CryptoJS.AES.encrypt(compressed, key(), { iv: iv() }).toString();
  } catch {
    throw new AppError({
      errorType: ERROR_TYPES.INTERNAL_ERROR,
      messageKey: 'encryption.encryptionError',
      code: 'INTERNAL_ERROR',
    });
  }
};

/**
 * Decrypt a transport ciphertext back to its JSON **string**.
 *
 * Returns the string rather than the parsed object to stay call-compatible
 * with the Elvee helper. Use `decryptToObject` for typed access.
 *
 * @throws AppError INVALID_REQUEST — a malformed or foreign-key ciphertext is
 * a client problem (400), not a server fault, and the reason is never echoed.
 */
export const decrypt = (data: string): string => {
  try {
    if (!data) {
      throw new Error('empty ciphertext');
    }

    const decrypted = CryptoJS.AES.decrypt(data, key(), { iv: iv() });
    const plaintext = decrypted.toString(CryptoJS.enc.Utf8);

    if (!plaintext) {
      throw new Error('ciphertext did not decrypt to UTF-8');
    }

    const decompressed = decompressData(plaintext);

    if (decompressed === '') {
      throw new Error('empty payload after decompression');
    }

    return decompressed;
  } catch {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'encryption.decryptionError',
      code: 'INVALID_REQUEST',
    });
  }
};

/** `decrypt` + `JSON.parse`, mapping a parse failure to the same 400. */
export const decryptToObject = <T = unknown>(data: string): T => {
  const plaintext = decrypt(data);

  try {
    return JSON.parse(plaintext) as T;
  } catch {
    throw new AppError({
      errorType: ERROR_TYPES.INVALID_REQUEST,
      messageKey: 'encryption.decryptionError',
      code: 'INVALID_REQUEST',
    });
  }
};

/**
 * Base64 SHA-256 — the lookup hash for refresh tokens, OTP codes and reset
 * tokens, which are stored hashed and never in the clear (rbac.md §1).
 * Not a password hash: passwords use bcrypt cost 12.
 */
export const getHash = (data: string): string =>
  CryptoJS.SHA256(data).toString(CryptoJS.enc.Base64);
