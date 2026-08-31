import { describe, expect, it, vi, beforeEach } from 'vitest';

const memberCount = vi.fn();
const memberFindMany = vi.fn();
const addressGroupBy = vi.fn();
const countryFindMany = vi.fn();

vi.mock('@db/prisma', () => ({
  prisma: {
    member: {
      count: (...a: unknown[]) => memberCount(...a),
      findMany: (...a: unknown[]) => memberFindMany(...a),
    },
    memberAddress: { groupBy: (...a: unknown[]) => addressGroupBy(...a) },
    country: { findMany: (...a: unknown[]) => countryFindMany(...a) },
  },
}));

const { getSiteStats, __resetSiteStatsCache } = await import('@modules/site/site.service');

beforeEach(() => {
  vi.clearAllMocks();
  __resetSiteStatsCache();
  memberCount.mockResolvedValue(0);
  memberFindMany.mockResolvedValue([]);
  addressGroupBy.mockResolvedValue([]);
  countryFindMany.mockResolvedValue([]);
});

/**
 * The homepage is the association's front door. A DRAFT company that has not
 * paid is not a member, and a member who asked to stay out of the directory is
 * not a name we publish — both rules are WHERE clauses here, not something a
 * component is trusted to filter afterwards.
 */
describe('getSiteStats', () => {
  it('counts only live ACTIVE members', async () => {
    memberCount.mockResolvedValue(512);

    const stats = await getSiteStats();

    expect(stats.members).toBe(512);
    expect(memberCount).toHaveBeenCalledWith({
      where: { deletedAt: null, status: 'ACTIVE' },
    });
  });

  /**
   * D1 (2026-08-31): the member directory is members-only, so the public
   * homepage may state how many members there are and never who they are.
   *
   * This is the test that keeps the decision. The two tests it replaces —
   * asserting the names and the logo URLs the homepage used to publish — are
   * kept commented below, because the code they cover is commented rather than
   * deleted and the pair must be restored together or not at all.
   */
  it('never names a member company, whatever the database holds', async () => {
    memberCount.mockResolvedValue(512);
    memberFindMany.mockResolvedValue([
      { id: 42n, company_name: 'Acme Diamonds', logo_path: 'members/42/abc.png' },
    ]);

    const stats = await getSiteStats();

    expect(stats.members).toBe(512);
    expect(JSON.stringify(stats)).not.toContain('Acme Diamonds');
    expect(JSON.stringify(stats)).not.toContain('logo');
    expect(stats).not.toHaveProperty('featured_members');
    // The name query is not merely filtered — it is never issued.
    expect(memberFindMany).not.toHaveBeenCalled();
  });

  /*
    DISABLED 2026-08-31 — D1. Restore alongside `listFeaturedMembers` in
    site.repository.ts if a public member wall is ever decided on its own terms.

    it('publishes names only for members who consented to the directory', async () => {
      memberFindMany.mockResolvedValue([{ id: 9n, company_name: 'Acme Diamonds', logo_path: null }]);
      const stats = await getSiteStats();
      expect(stats.featured_members).toEqual([{ name: 'Acme Diamonds', logo_url: null }]);
    });

    it('gives a member with a logo a URL a browser can load', async () => {
      memberFindMany.mockResolvedValue([
        { id: 42n, company_name: 'Acme Diamonds', logo_path: 'members/42/abc.png' },
      ]);
      const stats = await getSiteStats();
      expect(stats.featured_members).toEqual([
        { name: 'Acme Diamonds', logo_url: '/api/v1/public/members/42/logo' },
      ]);
    });
  */

  it('counts distinct countries and names the busiest ones', async () => {
    addressGroupBy.mockResolvedValue([
      { country_id: 1n, _count: { _all: 210 } },
      { country_id: 2n, _count: { _all: 12 } },
    ]);
    countryFindMany.mockResolvedValue([
      { id: 1n, name: 'India', iso_code: 'IN' },
      { id: 2n, name: 'Belgium', iso_code: 'BE' },
    ]);

    const stats = await getSiteStats();

    expect(stats.countries).toBe(2);
    expect(stats.hub_countries).toEqual([
      { iso_code: 'IN', name: 'India', members: 210 },
      { iso_code: 'BE', name: 'Belgium', members: 12 },
    ]);
  });

  it('answers an empty database with zeroes and empty lists, never null', async () => {
    const stats = await getSiteStats();

    expect(stats).toEqual({
      members: 0,
      countries: 0,
      hub_countries: [],
    });
  });

  /**
   * Four queries on every homepage render is four queries too many. The numbers
   * move once a day at most, so a five-minute window is invisible to a visitor
   * and removes the load entirely.
   */
  it('serves a second call from cache without re-querying', async () => {
    memberCount.mockResolvedValue(7);

    await getSiteStats();
    await getSiteStats();

    expect(memberCount).toHaveBeenCalledTimes(1);
  });
});
