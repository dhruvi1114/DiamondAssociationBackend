import { Prisma } from '@prisma/client';

import type { Db } from '@db/prisma';
import { DIRECTORY_FACET_LIMIT, DIRECTORY_PAGE_SIZE } from '@modules/directory/directory.constants';
import type { DirectoryRow, ListDirectoryQuery } from '@modules/directory/directory.types';

/**
 * The three switches, as one WHERE clause.
 *
 * Not a helper each caller is trusted to remember: a listed company must be
 * live, paid and consenting, and the only way to guarantee that is for every
 * read in this file to start from the same object. The global `directory.enabled`
 * switch is checked once in the service, before any of these run.
 */
const LISTED = {
  deletedAt: null,
  status: 'ACTIVE',
  directory_visible: true,
} as const;

/**
 * Exactly the allowlisted columns.
 *
 * `legal_name` is deliberately absent: it is searched in `filters` below and
 * never selected, so it cannot reach the presenter even by accident.
 */
const SELECT = {
  id: true,
  company_name: true,
  member_code: true,
  about: true,
  website: true,
  logo_path: true,
  joined_on: true,
  addresses: {
    where: { is_primary: true, deletedAt: null },
    select: { city: true, state: true },
    take: 1,
  },
  contacts: {
    where: { is_primary: true, deletedAt: null },
    select: { name: true, designation: true, email: true, phone: true },
    take: 1,
  },
  categories: { select: { category: { select: { name: true } } } },
} satisfies Prisma.MemberSelect;

const filters = (query: ListDirectoryQuery): Prisma.MemberWhereInput[] => {
  const where: Prisma.MemberWhereInput[] = [];

  if (query.q) {
    /*
      Trading name, registered name and description. Both names are searched;
      only the trading name is ever shown. Prisma parameterises the term, so a
      SQL string in the search box is matched as text, not executed.
    */
    where.push({
      OR: [
        { company_name: { contains: query.q, mode: 'insensitive' } },
        { legal_name: { contains: query.q, mode: 'insensitive' } },
        { about: { contains: query.q, mode: 'insensitive' } },
      ],
    });
  }

  const categories = query.category
    ? Array.isArray(query.category)
      ? query.category
      : [query.category]
    : [];

  if (categories.length) {
    where.push({ categories: { some: { category: { name: { in: categories } } } } });
  }

  if (query.city) {
    where.push({ addresses: { some: { is_primary: true, deletedAt: null, city: query.city } } });
  }

  if (query.state) {
    where.push({ addresses: { some: { is_primary: true, deletedAt: null, state: query.state } } });
  }

  return where;
};

export const listDirectory = async (
  db: Db,
  query: ListDirectoryQuery,
): Promise<{ rows: DirectoryRow[]; total: number }> => {
  const where: Prisma.MemberWhereInput = { ...LISTED, AND: filters(query) };

  const [rows, total] = await Promise.all([
    db.member.findMany({
      where,
      select: SELECT,
      /*
        The name breaks the tie on "newest". Two companies activated on the same
        day would otherwise be free to swap places between page one and page
        two, and a reader paging through would see one of them twice and the
        other never.
      */
      orderBy:
        query.sort === 'newest'
          ? [{ joined_on: 'desc' as const }, { company_name: 'asc' as const }]
          : [{ company_name: 'asc' as const }],
      skip: (query.page - 1) * DIRECTORY_PAGE_SIZE,
      /* The cap is here and nowhere else. No query parameter can raise it. */
      take: DIRECTORY_PAGE_SIZE,
    }),
    db.member.count({ where }),
  ]);

  return { rows: rows as unknown as DirectoryRow[], total };
};

export const findDirectoryMember = async (db: Db, id: bigint): Promise<DirectoryRow | null> =>
  (await db.member.findFirst({
    where: { ...LISTED, id },
    select: SELECT,
  })) as unknown as DirectoryRow | null;

/**
 * Facets for the filter dropdowns, counted against what is actually listed.
 *
 * A category nobody listed offers a filter that returns nothing, which reads as
 * a broken screen rather than an empty one.
 */
export const listCategoryFacets = (db: Db) =>
  db.membershipCategory.findMany({
    where: { is_active: true, member_links: { some: { member: { ...LISTED } } } },
    select: { name: true },
    orderBy: { display_order: 'asc' },
    take: DIRECTORY_FACET_LIMIT,
  });

/*
  States, distinct from the city list rather than derived from it.

  A city facet already carries its state, but "Gujarat" appears once per town in
  it — deriving the state list in the browser would mean the page deduplicating
  something the database can answer in one grouped read, and the count would be
  wrong the moment the facet limit truncated the cities.
*/
export const listStateFacets = (db: Db) =>
  db.memberAddress.findMany({
    where: { is_primary: true, deletedAt: null, member: { ...LISTED } },
    select: { state: true },
    distinct: ['state'],
    orderBy: { state: 'asc' },
    take: DIRECTORY_FACET_LIMIT,
  });

export const listCityFacets = (db: Db) =>
  db.memberAddress.findMany({
    where: { is_primary: true, deletedAt: null, member: { ...LISTED } },
    select: { city: true, state: true },
    distinct: ['city', 'state'],
    orderBy: [{ state: 'asc' }, { city: 'asc' }],
    take: DIRECTORY_FACET_LIMIT,
  });
