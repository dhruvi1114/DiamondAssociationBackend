/**
 * Identify a file by its bytes, not by what the upload claimed.
 *
 * `Content-Type` on a multipart part is attacker-controlled: a browser sends
 * whatever the client says, and a script sends whatever it likes. A `.pdf` that
 * is really HTML becomes stored XSS the moment a staff member opens it while
 * reviewing KYC (file-storage.md §3), so the only trustworthy answer comes from
 * the leading bytes.
 *
 * Four formats, matching the allowlist a document type may use. A dedicated
 * library would recognise hundreds more, which is precisely what we do not want:
 * anything unrecognised here is refused.
 */

export type SniffedMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

const startsWith = (buffer: Buffer, bytes: number[], offset = 0): boolean =>
  bytes.every((byte, index) => buffer[offset + index] === byte);

/**
 * Returns the MIME type the bytes actually describe, or `null` when the file is
 * not one of the four permitted formats.
 */
export const sniffMime = (buffer: Buffer): SniffedMime | null => {
  if (buffer.length < 12) return null;

  // %PDF-
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';

  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';

  // WebP: "RIFF" .... "WEBP"
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }

  return null;
};

/**
 * True when the bytes match one of the MIME types this document type permits.
 *
 * Both halves matter: the file must be a format we recognise, AND that format
 * must be one the association asked for. A valid PNG uploaded against a type
 * that only accepts PDF is still the wrong document.
 */
export const matchesAllowedMime = (buffer: Buffer, allowed: string[]): boolean => {
  const actual = sniffMime(buffer);

  return actual !== null && allowed.includes(actual);
};
