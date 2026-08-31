/** One country the association has members in, as the homepage map plots it. */
export interface SiteHubCountry {
  /** ISO 3166-1 alpha-2. The customer app maps this to a position on its map. */
  iso_code: string;
  name: string;
  members: number;
}

/**
 * The four numbers the public homepage is allowed to state as fact.
 *
 * Everything else on that page — years of leadership, global trade value,
 * annual production, the trend chart, the partner list — is marketing copy the
 * association supplies, and it lives in the customer app's constants rather
 * than pretending to be data (spec §2, decision D-3).
 */
/*
  DISABLED 2026-08-31 — decision D1 (docs/client-decisions.md): the member
  directory is members-only, so no member company name or logo may reach an
  anonymous caller. This code published both on the public homepage. It was
  written before that decision existed and is commented rather than deleted, so
  it can be restored whole if the association ever chooses a public member wall
  — which would be a new decision with its own consent, not a revival of this.
  See docs/specs/2026-08-31-member-directory.md §11.
*/
// export interface SiteFeaturedMember {
//   name: string;
//   logo_url: string | null;
// }

export interface SiteStats {
  members: number;
  countries: number;
  // featured_members: SiteFeaturedMember[];  // DISABLED 2026-08-31 — D1
  hub_countries: SiteHubCountry[];
}
