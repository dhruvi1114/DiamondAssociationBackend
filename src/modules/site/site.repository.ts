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

/** How many company names the marquee is given. It shows far fewer at a time. */
export const MEMBER_NAME_LIMIT = 24;

/** How many countries the map plots. Beyond a dozen the dots stop reading. */
export const HUB_COUNTRY_LIMIT = 12;

export const countActiveMembers = (db: Db) => db.member.count({ where: { ...ACTIVE_MEMBER } });

/**
 * Names for the marquee — and only from members who consented to appear.
 * `directory_visible` is the member's own choice; publishing a name against it
 * on the homepage would be the same disclosure the directory refuses to make.
 */
export const listActiveMemberNames = (db: Db) =>
  db.member.findMany({
    where: { ...ACTIVE_MEMBER, directory_visible: true },
    select: { company_name: true },
    orderBy: { company_name: 'asc' },
    take: MEMBER_NAME_LIMIT,
  });

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
