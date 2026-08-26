-- M7 — company team logins.
-- Wrapped in an explicit transaction: every statement here applies together or
-- not at all, so a half-created table can never be left behind (spec section 0.5).

BEGIN;

-- CreateTable
CREATE TABLE "MemberUsers" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "member_role" SMALLINT NOT NULL DEFAULT 1,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "invited_by_user_id" BIGINT,
    "accepted_at" TIMESTAMPTZ(6),
    "deactivated_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "MemberUsers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberTeamInvites" (
    "id" BIGSERIAL NOT NULL,
    "member_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "email" CITEXT NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "designation" VARCHAR(100),
    "invited_by_user_id" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" BIGINT,
    "created_by_admin_id" BIGINT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" BIGINT,
    "updated_by_admin_id" BIGINT,

    CONSTRAINT "MemberTeamInvites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberUsers_member_id_status_idx" ON "MemberUsers"("member_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MemberUsers_member_id_user_id_key" ON "MemberUsers"("member_id", "user_id");

-- CreateIndex
CREATE INDEX "MemberTeamInvites_member_id_createdAt_idx" ON "MemberTeamInvites"("member_id", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "MemberUsers" ADD CONSTRAINT "MemberUsers_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberUsers" ADD CONSTRAINT "MemberUsers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTeamInvites" ADD CONSTRAINT "MemberTeamInvites_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written half (migration-strategy.md "Comment step", ADR-013).
-- ---------------------------------------------------------------------------

-- Prisma declares no relation on MemberTeamInvites.user_id (the invite is read by
-- user id, never navigated as an object), so the FK is added here rather than
-- leaving the column unconstrained.
ALTER TABLE "MemberTeamInvites" ADD CONSTRAINT "MemberTeamInvites_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Exactly one OWNER per member. Partial, because TEAM rows are unrestricted.
CREATE UNIQUE INDEX "MemberUsers_one_owner_per_member"
  ON "MemberUsers" ("member_id")
  WHERE "member_role" = 0;

-- At most one open invite per address per firm. Accepted and revoked invites are
-- history and must not block a re-invite.
CREATE UNIQUE INDEX "MemberTeamInvites_one_open_per_email"
  ON "MemberTeamInvites" ("member_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- At most one actor per event. Both NULL means the system did it.
ALTER TABLE "MemberUsers" ADD CONSTRAINT "MemberUsers_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "MemberUsers" ADD CONSTRAINT "MemberUsers_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));
ALTER TABLE "MemberTeamInvites" ADD CONSTRAINT "MemberTeamInvites_created_by_one_actor"
  CHECK (NOT ("created_by_user_id" IS NOT NULL AND "created_by_admin_id" IS NOT NULL));
ALTER TABLE "MemberTeamInvites" ADD CONSTRAINT "MemberTeamInvites_updated_by_one_actor"
  CHECK (NOT ("updated_by_user_id" IS NOT NULL AND "updated_by_admin_id" IS NOT NULL));

-- Integer enum codes are only meaningful in range.
ALTER TABLE "MemberUsers" ADD CONSTRAINT "MemberUsers_member_role_range"
  CHECK ("member_role" IN (0, 1));
ALTER TABLE "MemberUsers" ADD CONSTRAINT "MemberUsers_status_range"
  CHECK ("status" IN (0, 1, 2));

-- An invite cannot be both accepted and revoked.
ALTER TABLE "MemberTeamInvites" ADD CONSTRAINT "MemberTeamInvites_not_both_outcomes"
  CHECK (NOT ("accepted_at" IS NOT NULL AND "revoked_at" IS NOT NULL));

-- Backfill: every existing member's primary login becomes its OWNER row, ACTIVE,
-- because those logins already have passwords. Both actor columns stay NULL: this
-- row was written by a migration, not by a person.
INSERT INTO "MemberUsers" (
  "member_id", "user_id", "member_role", "status", "accepted_at", "createdAt", "updatedAt"
)
SELECT m."id", m."primary_user_id", 0, 1, now(), now(), now()
FROM "Members" m
WHERE m."primary_user_id" IS NOT NULL
  AND m."deletedAt" IS NULL;

COMMENT ON TABLE "MemberUsers" IS 'One login belonging to one member company; the OWNER row is what resolves a signed-in user to a firm, replacing Members.primary_user_id.';
COMMENT ON COLUMN "MemberUsers"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MemberUsers"."member_id" IS 'FK to Members.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "MemberUsers"."user_id" IS 'FK to Users.id. ON DELETE NO ACTION.';
COMMENT ON COLUMN "MemberUsers"."member_role" IS '0 = OWNER (exactly one per member, partial unique index), 1 = TEAM.';
COMMENT ON COLUMN "MemberUsers"."status" IS '0 = INVITED, 1 = ACTIVE, 2 = DEACTIVATED. Only ACTIVE resolves to the company.';
COMMENT ON COLUMN "MemberUsers"."invited_by_user_id" IS 'Member login that sent the invite; NULL for the OWNER row.';
COMMENT ON COLUMN "MemberUsers"."accepted_at" IS 'When the invitee set their password and the row went ACTIVE.';
COMMENT ON COLUMN "MemberUsers"."deactivated_at" IS 'When an owner switched this person off.';
COMMENT ON COLUMN "MemberUsers"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MemberUsers"."created_by_user_id" IS 'Member login that created this row, if a member did.';
COMMENT ON COLUMN "MemberUsers"."created_by_admin_id" IS 'Staff account that created this row, if staff did.';
COMMENT ON COLUMN "MemberUsers"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MemberUsers"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "MemberUsers"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMENT ON TABLE "MemberTeamInvites" IS 'Outstanding invitations to join a company team; acceptance runs through the existing password-reset token so there is one password-setting path.';
COMMENT ON COLUMN "MemberTeamInvites"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "MemberTeamInvites"."member_id" IS 'FK to Members.id. ON DELETE CASCADE.';
COMMENT ON COLUMN "MemberTeamInvites"."user_id" IS 'FK to Users.id — the login created for the invitee. ON DELETE NO ACTION.';
COMMENT ON COLUMN "MemberTeamInvites"."email" IS 'Address the invite was sent to, as typed by the owner.';
COMMENT ON COLUMN "MemberTeamInvites"."full_name" IS 'Name as typed by the owner; copied onto Users.full_name.';
COMMENT ON COLUMN "MemberTeamInvites"."designation" IS 'Job title shown on the team screen and pre-filled into event attendee rows.';
COMMENT ON COLUMN "MemberTeamInvites"."invited_by_user_id" IS 'Member login that sent the invite.';
COMMENT ON COLUMN "MemberTeamInvites"."expires_at" IS 'When the invite stops being usable.';
COMMENT ON COLUMN "MemberTeamInvites"."accepted_at" IS 'Set when the invitee sets their password.';
COMMENT ON COLUMN "MemberTeamInvites"."revoked_at" IS 'Set when the owner cancels the invite before it is accepted.';
COMMENT ON COLUMN "MemberTeamInvites"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "MemberTeamInvites"."created_by_user_id" IS 'Member login that created this row.';
COMMENT ON COLUMN "MemberTeamInvites"."created_by_admin_id" IS 'Staff account that created this row.';
COMMENT ON COLUMN "MemberTeamInvites"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "MemberTeamInvites"."updated_by_user_id" IS 'Member login that last changed this row.';
COMMENT ON COLUMN "MemberTeamInvites"."updated_by_admin_id" IS 'Staff account that last changed this row.';

COMMIT;
