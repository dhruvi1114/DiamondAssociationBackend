-- Member directory search (docs/specs/2026-08-31-member-directory.md §6.3).
--
-- Additive only: no column is added, changed or dropped. Every field the
-- directory reads already exists on Members, MemberContacts, MemberAddresses
-- and MemberCategories.
--
-- Both the trading name and the registered legal name are searchable; only the
-- trading name is ever displayed. A member who knows the registered name should
-- find the company, but publishing a company under two names invites
-- impersonation and adds nothing to the card.
CREATE INDEX IF NOT EXISTS "members_directory_fts_idx"
  ON "Members"
  USING GIN (
    to_tsvector(
      'english',
      coalesce("company_name", '') || ' ' ||
      coalesce("legal_name", '')  || ' ' ||
      coalesce("about", '')
    )
  );

-- The city / state filter reaches Members through the primary address. Partial,
-- because the directory only ever reads the primary, live address.
CREATE INDEX IF NOT EXISTS "member_addresses_directory_city_idx"
  ON "MemberAddresses" ("city", "state")
  WHERE "is_primary" = true AND "deletedAt" IS NULL;
