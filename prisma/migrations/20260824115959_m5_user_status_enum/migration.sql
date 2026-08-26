-- Must run in its own migration: PostgreSQL requires enum additions to commit
-- before the new value can be used as a column default.
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
