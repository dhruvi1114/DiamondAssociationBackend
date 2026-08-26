/**
 * How many faces of a document must be collected, and whether they are all here.
 *
 * Pure — no Prisma, no I/O — because four callers depend on this answer
 * (upload validation, the applicant's checklist, the completeness gate and the
 * approve guard) and they must not each reimplement it.
 *
 * The literal unions mirror the Prisma enums `DocumentSides` and `DocumentSide`
 * exactly. They are restated rather than imported so this module can be tested
 * without a generated client.
 */

export type DocumentSidesValue = 'SINGLE' | 'FRONT_AND_BACK';
export type DocumentSideValue = 'SINGLE' | 'FRONT' | 'BACK' | 'COMBINED';

/** What the member is asked to hand over. Order is the order they are shown in. */
export const requiredSides = (sides: DocumentSidesValue): DocumentSideValue[] =>
  sides === 'FRONT_AND_BACK' ? ['FRONT', 'BACK'] : ['SINGLE'];

/**
 * Which faces are still owed.
 *
 * A `COMBINED` file settles a two-sided requirement on its own: a scanned ID is
 * normally one two-page PDF, and splitting it is busywork we would be imposing
 * on the applicant for the reviewer's convenience.
 */
export const missingSides = (
  sides: DocumentSidesValue,
  uploaded: DocumentSideValue[],
): DocumentSideValue[] => {
  if (sides === 'FRONT_AND_BACK' && uploaded.includes('COMBINED')) return [];

  const held = new Set(uploaded);

  return requiredSides(sides).filter((side) => !held.has(side));
};

/** Is this document type's requirement fully met by the files listed? */
export const isSatisfied = (sides: DocumentSidesValue, uploaded: DocumentSideValue[]): boolean =>
  missingSides(sides, uploaded).length === 0;

/**
 * What to store an incoming file as.
 *
 * The caller's requested side is advisory: a single-sided type stores `SINGLE`
 * however the request was labelled, and a PDF against a two-sided type is
 * `COMBINED` regardless — otherwise an applicant could upload the same PDF twice
 * and be recorded as having supplied two different faces.
 */
export const sideForUpload = (
  sides: DocumentSidesValue,
  requested: DocumentSideValue | undefined,
  mimeType: string,
): DocumentSideValue => {
  if (sides === 'SINGLE') return 'SINGLE';
  if (mimeType === 'application/pdf') return 'COMBINED';

  return requested === 'BACK' ? 'BACK' : 'FRONT';
};

/**
 * How a face is named in a sentence — "Aadhaar Card (back) is still needed".
 * Empty for a single file, so the qualifier can be appended unconditionally.
 */
export const SIDE_LABELS: Record<DocumentSideValue, string> = {
  SINGLE: '',
  FRONT: 'front',
  BACK: 'back',
  COMBINED: 'both sides',
};

/** "Aadhaar Card (back)", or just "PAN Card" for a single-sided type. */
export const describeSide = (name: string, side: DocumentSideValue): string =>
  SIDE_LABELS[side] ? `${name} (${SIDE_LABELS[side]})` : name;
