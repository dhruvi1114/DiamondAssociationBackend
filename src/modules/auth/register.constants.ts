import type { DocumentSideValue } from '@modules/document/document.sides';

/**
 * Multipart field names on `POST /auth/register`.
 *
 * The three registration documents used to be a fixed list with three fixed field
 * names. The association configures its own checklist now (M5), so the names are
 * derived from the type's code and the face instead: `document__AADHAAR_CARD__BACK`.
 *
 * The code is re-validated on parse against the same pattern screen A-12 enforces.
 * `multer.any()` would have removed the need for this codec and is deliberately not
 * used — `/auth/register` is public and unauthenticated, and an open field
 * whitelist there is a hole, not a convenience.
 */

const PREFIX = 'document';
const SEPARATOR = '__';
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SIDES: readonly DocumentSideValue[] = ['SINGLE', 'FRONT', 'BACK', 'COMBINED'];

export const uploadFieldName = (code: string, side: DocumentSideValue): string =>
  [PREFIX, code, side].join(SEPARATOR);

export const parseUploadFieldName = (
  field: string,
): { code: string; side: DocumentSideValue } | null => {
  const parts = field.split(SEPARATOR);
  if (parts.length !== 3) return null;

  const [prefix, code, side] = parts as [string, string, string];
  if (prefix !== PREFIX) return null;
  if (!CODE_PATTERN.test(code)) return null;
  if (!SIDES.includes(side as DocumentSideValue)) return null;

  return { code, side: side as DocumentSideValue };
};
