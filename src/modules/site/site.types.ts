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
export interface SiteStats {
  members: number;
  countries: number;
  member_names: string[];
  hub_countries: SiteHubCountry[];
}
