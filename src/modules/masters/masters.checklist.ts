import { prisma } from '@db/prisma';
import type { DocumentSidesValue } from '@modules/document/document.sides';

/**
 * Which documents each surface asks for.
 *
 * The single source of that answer. Registration, the member profile, the
 * completeness gate and the approve guard all read it, so "what is on the
 * checklist" is decided in one place and an admin's edit reaches all four at once.
 */

export interface ChecklistItem {
  id: bigint;
  code: string;
  name: string;
  description: string | null;
  is_required: boolean;
  sides: DocumentSidesValue;
  max_size_mb: number;
  allowed_mime: string[];
  display_order: number;
}

const SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  is_required: true,
  sides: true,
  max_size_mb: true,
  allowed_mime: true,
  display_order: true,
} as const;

const SURFACES = {
  APPLICATION: ['APPLICATION', 'BOTH'],
  MEMBER: ['MEMBER', 'BOTH'],
} as const;

export type ChecklistSurface = keyof typeof SURFACES;

/** Active rows for one surface, in the order the admin arranged them. */
export const checklistFor = async (surface: ChecklistSurface): Promise<ChecklistItem[]> =>
  (await prisma.documentType.findMany({
    where: { deletedAt: null, is_active: true, applies_to: { in: [...SURFACES[surface]] } },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
    select: SELECT,
  })) as ChecklistItem[];

/**
 * The type a NEW upload names. Retired and deactivated types are refused — the
 * association has stopped asking for them.
 */
export const findTypeForUpload = async (code: string): Promise<ChecklistItem | null> =>
  (await prisma.documentType.findFirst({
    where: { code, deletedAt: null, is_active: true },
    select: SELECT,
  })) as ChecklistItem | null;

/**
 * The type an EXISTING file points at. Deliberately unfiltered.
 *
 * A file already uploaded must always resolve its type, even one since retired,
 * or the member's own document list breaks when an admin tidies the master. This
 * is the failure that caused the foreign key to be dropped on 2026-08-24 — do not
 * add a `deletedAt` filter here.
 */
export const findTypeById = async (id: bigint): Promise<ChecklistItem | null> =>
  (await prisma.documentType.findFirst({ where: { id }, select: SELECT })) as ChecklistItem | null;
