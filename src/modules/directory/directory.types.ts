import { z } from 'zod';

import { DIRECTORY_PAGE_SIZE } from '@modules/directory/directory.constants';

/**
 * The listing query.
 *
 * `limit` is deliberately absent. The page size is the server's decision, not
 * the caller's — a directory that honours `?limit=10000` is a directory that
 * can be taken in one request.
 */
export const listDirectorySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  category: z.union([z.string(), z.array(z.string())]).optional(),
  city: z.string().trim().max(100).optional(),
  state: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  /*
    Two orders. A–Z is a directory's own order — a reader looking for a company
    they can half-remember scans an alphabet. "Newest" answers the other
    question people bring to a member list: who has joined recently.
  */
  sort: z.enum(['az', 'newest']).default('az'),
});

export const directorySlugSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(240)
    /* `<name>-<id>`; the trailing id is what the lookup actually uses. */
    .regex(/-\d+$/, 'directory.badSlug'),
});

export type ListDirectoryQuery = z.infer<typeof listDirectorySchema>;

/** One row as the repository selects it. Nothing here that is not allowlisted. */
export interface DirectoryRow {
  id: bigint;
  company_name: string;
  member_code: string | null;
  about: string | null;
  website: string | null;
  logo_path: string | null;
  joined_on: Date | null;
  addresses: { city: string; state: string }[];
  contacts: {
    name: string;
    designation: string | null;
    email: string | null;
    phone: string | null;
  }[];
  categories: { category: { name: string } }[];
}

export interface DirectoryCard {
  slug: string;
  companyName: string;
  city: string | null;
  state: string | null;
  categories: string[];
  logoUrl: string | null;
  /** The year the membership first became active, or null before it did. */
  joinedYear: number | null;
  website: string | null;
}

export interface DirectoryContact {
  name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
}

export interface DirectoryProfile extends DirectoryCard {
  memberCode: string | null;
  about: string | null;
  contact: DirectoryContact | null;
}

export { DIRECTORY_PAGE_SIZE };
