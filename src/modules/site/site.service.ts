import { prisma } from '@db/prisma';
import { logoUrl } from '@modules/member/member.logo.service';
import * as repo from '@modules/site/site.repository';
import type { SiteStats } from '@modules/site/site.types';

/**
 * The public homepage's four facts.
 *
 * Cached in process for five minutes. The homepage is the most-hit page in the
 * product and these numbers move once a day at most, so the alternative is four
 * queries per visitor for a figure that would not have changed between them.
 * The cache is deliberately per-process and not shared: a stale count on one
 * node for at most five minutes is not a correctness problem, and a shared
 * cache would be new infrastructure for a rounding-scale benefit.
 */

const TTL_MS = 5 * 60 * 1000;

let cached: { at: number; value: SiteStats } | null = null;

/** Test seam. Never called by application code. */
export const __resetSiteStatsCache = (): void => {
  cached = null;
};

const load = async (): Promise<SiteStats> => {
  const [members, featured, groups] = await Promise.all([
    repo.countActiveMembers(prisma),
    repo.listFeaturedMembers(prisma),
    repo.groupMembersByCountry(prisma),
  ]);

  /*
    Sorted here rather than in the query. Prisma's `orderBy` on a groupBy
    aggregate is version-sensitive, and a dozen rows sort for free — the
    ordering only decides which countries get a dot, never the count.
  */
  const ranked = [...groups].sort((a, b) => b._count._all - a._count._all);

  const ids = ranked.map((group) => group.country_id).filter((id): id is bigint => id !== null);

  const countries = ids.length ? await repo.findCountriesByIds(prisma, ids) : [];
  const byId = new Map(countries.map((country) => [country.id.toString(), country]));

  const hub_countries = ranked.slice(0, repo.HUB_COUNTRY_LIMIT).flatMap((group) => {
    const country = group.country_id ? byId.get(group.country_id.toString()) : undefined;
    if (!country) return [];

    return [{ iso_code: country.iso_code, name: country.name, members: group._count._all }];
  });

  return {
    members,
    countries: ids.length,
    featured_members: featured.map((row) => ({
      name: row.company_name,
      logo_url: row.logo_path ? logoUrl(row.id) : null,
    })),
    hub_countries,
  };
};

export const getSiteStats = async (): Promise<SiteStats> => {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const value = await load();
  cached = { at: Date.now(), value };

  return value;
};
