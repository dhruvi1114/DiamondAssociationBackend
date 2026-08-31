import type { Db } from '@db/prisma';

/**
 * Reads behind the public homepage.
 *
 * Every query here filters `deletedAt: null` and `status: ACTIVE`. That pairing
 * is the whole reason these live in one file: "the homepage counts paid members
 * only" is a WHERE clause in this module, not a rule each caller is trusted to
 * remember.
 */

const ACTIVE_MEMBER = { deletedAt: null, status: 'ACTIVE' } as const;

/*
  DISABLED 2026-08-31 — decision D1 (docs/client-decisions.md): the member
  directory is members-only, so no member company name or logo may reach an
  anonymous caller. This code published both on the public homepage. It was
  written before that decision existed and is commented rather than deleted, so
  it can be restored whole if the association ever chooses a public member wall
  — which would be a new decision with its own consent, not a revival of this.
  See docs/specs/2026-08-31-member-directory.md §11.
*/
// /** How many companies the marquee is given. It shows far fewer at a time. */
// export const MEMBER_NAME_LIMIT = 24;

/** How many countries the map plots. Beyond a dozen the dots stop reading. */
export const HUB_COUNTRY_LIMIT = 12;

export const countActiveMembers = (db: Db) => db.member.count({ where: { ...ACTIVE_MEMBER } });

// DISABLED 2026-08-31 — D1, see the note above.
// export const listFeaturedMembers = (db: Db) =>
//   db.member.findMany({
//     where: { ...ACTIVE_MEMBER, directory_visible: true },
//     select: { id: true, company_name: true, logo_path: true },
//     orderBy: [{ logo_path: { sort: 'asc', nulls: 'last' } }, { company_name: 'asc' }],
//     take: MEMBER_NAME_LIMIT,
//   });

/**
 * Members per country, busiest first.
 *
 * Grouped on the address rather than the member because the country lives on
 * the address. A member with two addresses in one country is counted twice
 * here, which affects only the ordering of the dots — never the country count,
 * which is the number of groups.
 */
export const groupMembersByCountry = (db: Db) =>
  db.memberAddress.groupBy({
    by: ['country_id'],
    where: {
      deletedAt: null,
      country_id: { not: null },
      member: { ...ACTIVE_MEMBER },
    },
    _count: { _all: true },
  });

export const findCountriesByIds = (db: Db, ids: bigint[]) =>
  db.country.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, iso_code: true },
  });
