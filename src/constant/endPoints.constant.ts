export const END_POINTS = {
  COMMON: '/api',
  V1: '/v1',

  // Unauthenticated infrastructure endpoints (decryption + auth bypass list).
  HEALTH: '/health',
  WEBHOOKS: '/webhooks',

  // Audience prefixes (api-conventions.md §1).
  ADMIN: '/admin',
  PUBLIC: '/public',

  // Domain resources — mounted by later cycles.
  AUTH: '/auth',
  MEMBERS: '/members',
  // `/applications`, matching api-specification.md §M4. The earlier
  // `/membership-applications` was invented in M0 before the spec was written
  // and never used by anything.
  APPLICATIONS: '/applications',
  INVOICES: '/invoices',
  PAYMENTS: '/payments',
  EVENTS: '/events',
  NOTICES: '/notices',
  // M9 — the association's own writing, published to the public website. Not a
  // notice: a notice is pushed to chosen members, news is a page anyone can read.
  NEWS: '/news',
  NEWS_CATEGORIES: '/news-categories',
  // The public marketing homepage's own numbers — member and country counts.
  SITE: '/site',
  NOTIFICATIONS: '/notifications',
  DOCUMENTS: '/documents',
  DIRECTORY: '/directory',

  // M2 — membership catalogue. Admin-only writes; the public site reads the
  // published subset through PUBLIC + MEMBERSHIP.
  CATEGORIES: '/membership-categories',
  TIERS: '/membership-tiers',
  FEES: '/fee-structures',
  DOCUMENT_TYPES: '/document-types',
  DOCUMENT_CHECKLIST: '/document-checklist',
  MEMBERSHIP: '/membership',
  REGISTRATION_OPTIONS: '/registration-options',
  REGISTRATION_CONSENT: '/registration-consent',
  // M5 — registration masters
  COMPANY_TYPES: '/company-types',
  EVENT_TYPES: '/event-types',
  COUNTRIES: '/countries',
  STATES: '/states',
  CITIES: '/cities',
} as const;

export type EndpointKey = keyof typeof END_POINTS;

/** `/api/v1` — every route in this service hangs off this prefix. */
export const API_V1 = `${END_POINTS.COMMON}${END_POINTS.V1}` as const;
