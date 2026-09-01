import { prisma } from '@db/prisma';
import { getBooleanSetting, SETTING_KEYS } from '@helpers/settings';
import { DIRECTORY_DENY, DIRECTORY_PAGE_SIZE } from '@modules/directory/directory.constants';
import { assertDirectoryAccess, directoryDenied } from '@modules/directory/directory.gate';
import { idFromSlug, presentCard, presentProfile } from '@modules/directory/directory.presenter';
import * as repo from '@modules/directory/directory.repository';
import type { ListDirectoryQuery } from '@modules/directory/directory.types';
import { openPublicLogo } from '@modules/member/member.logo.service';

/**
 * The member directory.
 *
 * Every entry point starts the same way: prove the caller is an ACTIVE member,
 * then prove the association has the directory switched on. Neither check is
 * something a caller can sidestep by choosing a different endpoint, which is
 * why they live here rather than in the controller or the router.
 */
const open = async (userId: bigint): Promise<void> => {
  await assertDirectoryAccess(userId);

  /*
    Default true. A database that has never been seeded with this key still
    serves the directory to paying members, rather than silently withholding a
    benefit because a settings row is missing.
  */
  if (!(await getBooleanSetting(SETTING_KEYS.DIRECTORY_ENABLED, true))) {
    throw directoryDenied(DIRECTORY_DENY.DIRECTORY_OFF);
  }
};

export const list = async (userId: bigint, query: ListDirectoryQuery) => {
  await open(userId);

  const { rows, total } = await repo.listDirectory(prisma, query);

  return {
    items: rows.map(presentCard),
    page: query.page,
    pageSize: DIRECTORY_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE)),
  };
};

export const detail = async (userId: bigint, slug: string) => {
  await open(userId);

  const id = idFromSlug(slug);

  if (id === null) return null;

  const row = await repo.findDirectoryMember(prisma, id);

  return row ? presentProfile(row) : null;
};

export const facets = async (userId: bigint) => {
  await open(userId);

  const [categories, cities, states] = await Promise.all([
    repo.listCategoryFacets(prisma),
    repo.listCityFacets(prisma),
    repo.listStateFacets(prisma),
  ]);

  return {
    categories: categories.map((cat) => cat.name),
    cities: cities.map((place) => ({ city: place.city, state: place.state })),
    states: states.map((place) => place.state),
  };
};

/**
 * The logo, behind the same gate as everything else.
 *
 * `openPublicLogo` enforces ACTIVE + `directory_visible` on the member being
 * fetched; `open` enforces it on the member asking. Both halves are needed —
 * one decides who may look, the other decides who may be looked at. Its name is
 * a leftover from when the homepage served logos publicly; the query it runs is
 * exactly what this module needs, so it is reused rather than duplicated.
 */
export const logo = async (userId: bigint, memberId: bigint) => {
  await open(userId);

  return openPublicLogo(memberId);
};
