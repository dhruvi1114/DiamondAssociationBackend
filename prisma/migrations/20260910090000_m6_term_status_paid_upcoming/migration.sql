-- M6 — renewal. Must run in its own migration: PostgreSQL requires an enum addition to
-- commit before the new value can be used (by the partial index in the next migration).
ALTER TYPE "TermStatus" ADD VALUE IF NOT EXISTS 'PAID_UPCOMING' AFTER 'PENDING_PAYMENT';
