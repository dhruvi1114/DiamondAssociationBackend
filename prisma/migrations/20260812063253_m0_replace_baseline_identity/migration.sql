-- =============================================================================
-- M0 — Foundation & Shared Core
--
-- Replaces the skeleton baseline identity model with the real one and creates
-- the cross-cutting tables every later cycle depends on: RBAC, audit, settings,
-- job runs and the notification outbox (ADR-015).
--
-- This is the ONE deliberately destructive migration in the project: it drops
-- the placeholder "User" table from baseline 20260225095547. Safe only because
-- no environment beyond a developer laptop has ever held data
-- (migration-strategy.md §"Baseline handling"). The baseline itself is not
-- edited (ADR-001).
--
-- Hand-written additions to the Prisma-generated SQL, in order:
--   1. extensions            citext / pg_trgm / btree_gist
--   2. partial unique indexes soft delete makes a plain UNIQUE wrong
--   3. AuditLogs privileges  append-only note
--   4. COMMENT ON block      ADR-013, generated from the schema /// docs
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extensions (versions.md, database-design.md §H.5)
--    citext      case-insensitive email columns below depend on this type
--    pg_trgm     directory / member search (M9)
--    btree_gist  FeeStructures daterange exclusion constraint (M2)
--    Created here rather than per-cycle so a fresh database is usable from the
--    first migration onward.
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

/*
  Warnings:

  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('MEMBER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SettingValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- DropTable
DROP TABLE "User";

-- DropEnum
DROP TYPE "UserRole";

-- CreateTable
CREATE TABLE "NotificationTemplates" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" VARCHAR(10) NOT NULL DEFAULT 'en',
    "subject" VARCHAR(200),
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NotificationTemplates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notifications" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT,
    "admin_user_id" BIGINT,
    "member_id" BIGINT,
    "channel" "NotificationChannel" NOT NULL,
    "template_code" VARCHAR(80) NOT NULL,
    "payload_json" JSONB NOT NULL,
    "to_address" VARCHAR(200),
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Users" (
    "id" BIGSERIAL NOT NULL,
    "email" CITEXT NOT NULL,
    "phone" VARCHAR(20),
    "password_hash" TEXT NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "email_verified_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUsers" (
    "id" BIGSERIAL NOT NULL,
    "email" CITEXT NOT NULL,
    "phone" VARCHAR(20),
    "password_hash" TEXT NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "email_verified_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_by_admin_id" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),

    CONSTRAINT "AdminUsers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Roles" (
    "id" BIGSERIAL NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permissions" (
    "id" BIGSERIAL NOT NULL,
    "module" VARCHAR(50) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermissions" (
    "id" BIGSERIAL NOT NULL,
    "role_id" BIGINT NOT NULL,
    "permission_id" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUserRoles" (
    "id" BIGSERIAL NOT NULL,
    "admin_user_id" BIGINT NOT NULL,
    "role_id" BIGINT NOT NULL,
    "assigned_by_admin_id" BIGINT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUserRoles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogs" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" BIGINT,
    "action" VARCHAR(80) NOT NULL,
    "entity_name" VARCHAR(60) NOT NULL,
    "entity_id" BIGINT,
    "before_json" JSONB,
    "after_json" JSONB,
    "ip" INET,
    "user_agent" TEXT,
    "request_id" VARCHAR(64),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSettings" (
    "id" BIGSERIAL NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "SettingValueType" NOT NULL DEFAULT 'STRING',
    "group" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRuns" (
    "id" BIGSERIAL NOT NULL,
    "job_name" VARCHAR(80) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "status" "JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "JobRuns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationTemplates_code_channel_locale_key" ON "NotificationTemplates"("code", "channel", "locale");

-- CreateIndex
CREATE INDEX "Notifications_status_next_attempt_at_idx" ON "Notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "Notifications_user_id_channel_read_at_idx" ON "Notifications"("user_id", "channel", "read_at");

-- CreateIndex
CREATE INDEX "Notifications_admin_user_id_channel_read_at_idx" ON "Notifications"("admin_user_id", "channel", "read_at");

-- CreateIndex
CREATE INDEX "Notifications_member_id_idx" ON "Notifications"("member_id");

-- CreateIndex
CREATE INDEX "Users_status_createdAt_idx" ON "Users"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminUsers_status_createdAt_idx" ON "AdminUsers"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminUsers_created_by_admin_id_idx" ON "AdminUsers"("created_by_admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "Roles_code_key" ON "Roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Permissions_code_key" ON "Permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Permissions_module_action_key" ON "Permissions"("module", "action");

-- CreateIndex
CREATE INDEX "RolePermissions_permission_id_idx" ON "RolePermissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermissions_role_id_permission_id_key" ON "RolePermissions"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "AdminUserRoles_role_id_idx" ON "AdminUserRoles"("role_id");

-- CreateIndex
CREATE INDEX "AdminUserRoles_assigned_by_admin_id_idx" ON "AdminUserRoles"("assigned_by_admin_id");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUserRoles_admin_user_id_role_id_key" ON "AdminUserRoles"("admin_user_id", "role_id");

-- CreateIndex
CREATE INDEX "AuditLogs_entity_name_entity_id_createdAt_idx" ON "AuditLogs"("entity_name", "entity_id", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLogs_actor_type_actor_id_createdAt_idx" ON "AuditLogs"("actor_type", "actor_id", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditLogs_createdAt_idx" ON "AuditLogs"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SystemSettings_key_key" ON "SystemSettings"("key");

-- CreateIndex
CREATE INDEX "SystemSettings_group_idx" ON "SystemSettings"("group");

-- CreateIndex
CREATE INDEX "JobRuns_job_name_started_at_idx" ON "JobRuns"("job_name", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notifications" ADD CONSTRAINT "Notifications_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "AdminUsers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUsers" ADD CONSTRAINT "AdminUsers_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "AdminUsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermissions" ADD CONSTRAINT "RolePermissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "Roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermissions" ADD CONSTRAINT "RolePermissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "Permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUserRoles" ADD CONSTRAINT "AdminUserRoles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "AdminUsers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUserRoles" ADD CONSTRAINT "AdminUserRoles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "Roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminUserRoles" ADD CONSTRAINT "AdminUserRoles_assigned_by_admin_id_fkey" FOREIGN KEY ("assigned_by_admin_id") REFERENCES "AdminUsers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 2. Partial unique indexes (database-design.md §H.1, database-indexes.md)
--
--    Soft-deleted tables cannot carry a plain UNIQUE: it would permanently
--    reserve the email address of a member who was deleted, so they could never
--    re-register. Prisma cannot express a partial index, so these are written
--    by hand and the corresponding fields deliberately carry no `@unique`.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "Users_email_active_key"
    ON "Users" ("email")
    WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Users_phone_active_key"
    ON "Users" ("phone")
    WHERE "phone" IS NOT NULL AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "AdminUsers_email_active_key"
    ON "AdminUsers" ("email")
    WHERE "deletedAt" IS NULL;

-- -----------------------------------------------------------------------------
-- 3. AuditLogs is append-only (database-design.md §G)
--
--    "REVOKE UPDATE, DELETE ON \"AuditLogs\" FROM <app_role>" belongs here, but
--    the role that the API connects as is an environment decision, not a schema
--    one, and a REVOKE against a superuser (the local dev connection) is a
--    silent no-op that would read as protection without being any.
--    It is therefore part of provisioning — deployment.md — and is asserted by
--    the Sentinel schema suite rather than assumed here.
-- -----------------------------------------------------------------------------

-- ============================================================================
-- Table & column comments (ADR-013 / database-design.md §I)
-- Generated from the /// doc-comments in prisma/schema/*.prisma by
--   npx tsx scripts/emit-db-comments.ts
-- Keep both sides in step: regenerate rather than editing this block by hand.
-- ============================================================================

COMMENT ON TABLE "NotificationTemplates" IS 'The authored content for one message, per channel and locale. Content lives in rows rather than in code so the association can reword a message without a deploy (notification-architecture.md §4).';
COMMENT ON COLUMN "NotificationTemplates"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "NotificationTemplates"."code" IS 'Message identifier, e.g. auth.signup_otp. Services queue by this code, so it is a contract and is never renamed once released.';
COMMENT ON COLUMN "NotificationTemplates"."channel" IS 'Channel this rendering is for: EMAIL, WHATSAPP or IN_APP. The same code exists once per channel because an SMS and an email say the same thing at very different lengths.';
COMMENT ON COLUMN "NotificationTemplates"."locale" IS 'BCP-47-ish language tag, matching APP_LANGUAGES. Defaults to en.';
COMMENT ON COLUMN "NotificationTemplates"."subject" IS 'Email subject line, with {{placeholders}}. NULL for channels that have no subject.';
COMMENT ON COLUMN "NotificationTemplates"."body" IS 'Message body with {{placeholders}} substituted from Notifications.payload_json. Plain text or simple HTML; never rendered with dangerouslySetInnerHTML on the client.';
COMMENT ON COLUMN "NotificationTemplates"."is_active" IS 'Soft on/off switch used instead of deletion so historic references stay resolvable.';
COMMENT ON COLUMN "NotificationTemplates"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "NotificationTemplates"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "Notifications" IS 'The notification outbox (ADR-010/ADR-015): one row per message per recipient per channel. Services INSERT here inside the same transaction as the business change and never call a provider inline, so a dead mail server can never roll back an approval. A drain job dispatches, retries with backoff, and gives up visibly rather than silently.';
COMMENT ON COLUMN "Notifications"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Notifications"."user_id" IS 'FK to Users.id — the member recipient. ON DELETE CASCADE. NULL when the recipient is staff. Exactly one of user_id / admin_user_id is set.';
COMMENT ON COLUMN "Notifications"."admin_user_id" IS 'FK to AdminUsers.id — the staff recipient. ON DELETE CASCADE. NULL for member messages.';
COMMENT ON COLUMN "Notifications"."member_id" IS 'Members.id this message concerns, for filtering an organisation''s message history. Column exists from M0; the foreign key is added in M3 with the Members table, because the outbox is built before the membership model (ADR-015).';
COMMENT ON COLUMN "Notifications"."channel" IS 'Delivery channel: EMAIL, WHATSAPP or IN_APP.';
COMMENT ON COLUMN "Notifications"."template_code" IS 'NotificationTemplates.code to render. Resolved at drain time with channel + locale, so a reworded template applies to messages already queued.';
COMMENT ON COLUMN "Notifications"."payload_json" IS 'Template variables, e.g. {"full_name":"…","otp":"…"}. Documented JSON use: these are per-message substitutions, not relational data. Never logged — it can hold an OTP.';
COMMENT ON COLUMN "Notifications"."to_address" IS 'Resolved destination: email address, or phone number for WhatsApp. NULL for IN_APP, which has no address. Snapshotted at queue time so a later profile edit cannot silently redirect a message that has already been raised.';
COMMENT ON COLUMN "Notifications"."status" IS 'Outbox state: QUEUED, SENDING, SENT, FAILED, CANCELLED.';
COMMENT ON COLUMN "Notifications"."attempt_count" IS 'Delivery attempts made so far. The drain gives up at 5 (notification-architecture.md §8).';
COMMENT ON COLUMN "Notifications"."next_attempt_at" IS 'Earliest instant (UTC) this row may be picked up again — now + 2^attempt minutes after a failure. Paired with status in the drain index; NULL means never retry.';
COMMENT ON COLUMN "Notifications"."sent_at" IS 'When the provider accepted the message (UTC). NULL until SENT.';
COMMENT ON COLUMN "Notifications"."error" IS 'Last failure reason, kept so a FAILED row in the admin outbox explains itself. Provider message only; never a stack trace and never the rendered body.';
COMMENT ON COLUMN "Notifications"."read_at" IS 'When the member opened this IN_APP item (UTC). NULL means unread; drives the bell badge. Always NULL for EMAIL and WHATSAPP, which have no read signal.';
COMMENT ON COLUMN "Notifications"."createdAt" IS 'Row creation timestamp (UTC) — when the business event queued the message.';
COMMENT ON COLUMN "Notifications"."updatedAt" IS 'Last modification timestamp (UTC) — bumped on every delivery attempt.';

COMMENT ON TABLE "Users" IS 'A member/applicant login account. Separate from AdminUsers so a member token can never address a staff route and RBAC never applies to the public side (ADR-002). One row per person who signs in on the customer portal; the organisation they represent is a Members row created later (M3).';
COMMENT ON COLUMN "Users"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Users"."email" IS 'Login identifier. citext so "A@b.com" and "a@b.com" are the same account. Unique among live rows only — the unique index is partial on deletedAt IS NULL so a deleted member can re-register with the same address.';
COMMENT ON COLUMN "Users"."phone" IS 'Optional mobile number in E.164-ish form, used for OTP and WhatsApp. Unique where present and not soft-deleted; NULL never collides.';
COMMENT ON COLUMN "Users"."password_hash" IS 'bcrypt hash, cost 12 (rbac.md §1). Never logged, never returned, never compared outside the auth service.';
COMMENT ON COLUMN "Users"."full_name" IS 'Person''s name as they entered it, used in salutations and the approver''s view.';
COMMENT ON COLUMN "Users"."status" IS 'Account lifecycle: PENDING_VERIFICATION, ACTIVE, INACTIVE, BLOCKED. Only ACTIVE may sign in.';
COMMENT ON COLUMN "Users"."email_verified_at" IS 'When the signup OTP was accepted (UTC). NULL means the address is unproven.';
COMMENT ON COLUMN "Users"."last_login_at" IS 'Last successful sign-in (UTC). Dormant-account reporting; not an audit record.';
COMMENT ON COLUMN "Users"."failed_login_count" IS 'Consecutive failed sign-ins. Reset to 0 on success; 5 triggers the lockout (rbac.md §1).';
COMMENT ON COLUMN "Users"."locked_until" IS 'Sign-in barred until this instant (UTC) after repeated failures. NULL means not locked.';
COMMENT ON COLUMN "Users"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Users"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "Users"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "AdminUsers" IS 'A staff login account: association office, approvers and accounts. Held apart from Users so the two audiences have different credential policies, different token audiences and no escalation path between them (ADR-002).';
COMMENT ON COLUMN "AdminUsers"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "AdminUsers"."email" IS 'Login identifier, case-insensitive. Unique among live rows only (partial on deletedAt).';
COMMENT ON COLUMN "AdminUsers"."phone" IS 'Optional contact number for the staff member. Not a login factor and not unique.';
COMMENT ON COLUMN "AdminUsers"."password_hash" IS 'bcrypt hash, cost 12. Admin passwords have a 12-character minimum (rbac.md §1).';
COMMENT ON COLUMN "AdminUsers"."full_name" IS 'Staff member''s display name, shown on approval history and audit rows.';
COMMENT ON COLUMN "AdminUsers"."status" IS 'Account lifecycle: PENDING_VERIFICATION, ACTIVE, INACTIVE, BLOCKED. Only ACTIVE may sign in.';
COMMENT ON COLUMN "AdminUsers"."email_verified_at" IS 'When this staff address was verified (UTC). NULL for accounts created directly by an admin.';
COMMENT ON COLUMN "AdminUsers"."last_login_at" IS 'Last successful sign-in (UTC).';
COMMENT ON COLUMN "AdminUsers"."failed_login_count" IS 'Consecutive failed sign-ins. Reset to 0 on success; 5 triggers the lockout.';
COMMENT ON COLUMN "AdminUsers"."locked_until" IS 'Sign-in barred until this instant (UTC). NULL means not locked.';
COMMENT ON COLUMN "AdminUsers"."is_super_admin" IS 'TRUE bypasses every permission check (rbac.md §2). Bypasses are themselves audited, and only a super admin may grant this flag.';
COMMENT ON COLUMN "AdminUsers"."created_by_admin_id" IS 'FK to AdminUsers.id — the staff member who created this account. ON DELETE SET NULL: removing a creator must never remove the accounts they set up.';
COMMENT ON COLUMN "AdminUsers"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "AdminUsers"."updatedAt" IS 'Last modification timestamp (UTC).';
COMMENT ON COLUMN "AdminUsers"."deletedAt" IS 'Soft-delete timestamp (UTC). NULL means active; all reads filter deletedAt IS NULL.';

COMMENT ON TABLE "Roles" IS 'A named bundle of permissions granted to staff. Seeded set: SUPER_ADMIN, ADMIN, APPROVER, ACCOUNTS (rbac.md §3). Approval stages point at a role, so a role is also the unit that decides who may act on a queue.';
COMMENT ON COLUMN "Roles"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Roles"."code" IS 'Stable machine code, e.g. SUPER_ADMIN. Referenced by seeds and approval stages, so it is never renamed once released.';
COMMENT ON COLUMN "Roles"."name" IS 'Human label shown in the admin UI.';
COMMENT ON COLUMN "Roles"."description" IS 'What this role is for, shown as help text on the role screen.';
COMMENT ON COLUMN "Roles"."is_system" IS 'TRUE for the four seeded roles: they may be re-granted but never renamed or deleted, because approval workflows and seeds resolve them by code.';
COMMENT ON COLUMN "Roles"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Roles"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "Permissions" IS 'One grantable capability, e.g. application.approve. The full catalogue is seeded from rbac.md §3; rows are never created at runtime, so an unknown code in a guard is a bug rather than a missing row.';
COMMENT ON COLUMN "Permissions"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "Permissions"."module" IS 'Functional area this permission belongs to, e.g. application. Groups the permission matrix screen.';
COMMENT ON COLUMN "Permissions"."action" IS 'Operation within the module, e.g. approve.';
COMMENT ON COLUMN "Permissions"."code" IS 'Canonical "<module>.<action>" string used in authorize() calls and JWT claims. Unique.';
COMMENT ON COLUMN "Permissions"."description" IS 'Plain-language description of what holding this permission allows.';
COMMENT ON COLUMN "Permissions"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "Permissions"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "RolePermissions" IS 'Grant of one permission to one role. Join table, no attributes of its own.';
COMMENT ON COLUMN "RolePermissions"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "RolePermissions"."role_id" IS 'FK to Roles.id — the role receiving the grant. ON DELETE CASCADE: deleting a role removes its grants, which are meaningless without it.';
COMMENT ON COLUMN "RolePermissions"."permission_id" IS 'FK to Permissions.id — the capability granted. ON DELETE CASCADE.';
COMMENT ON COLUMN "RolePermissions"."createdAt" IS 'Row creation timestamp (UTC).';

COMMENT ON TABLE "AdminUserRoles" IS 'Assignment of one role to one staff account, with a record of who assigned it.';
COMMENT ON COLUMN "AdminUserRoles"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "AdminUserRoles"."admin_user_id" IS 'FK to AdminUsers.id — the staff member holding the role. ON DELETE CASCADE.';
COMMENT ON COLUMN "AdminUserRoles"."role_id" IS 'FK to Roles.id — the role held. ON DELETE RESTRICT: a role still assigned to somebody cannot be deleted out from under them.';
COMMENT ON COLUMN "AdminUserRoles"."assigned_by_admin_id" IS 'FK to AdminUsers.id — who granted this role. ON DELETE SET NULL so the grant survives the granter leaving. This is the "who gave them access" question in an access review.';
COMMENT ON COLUMN "AdminUserRoles"."createdAt" IS 'Row creation timestamp (UTC), i.e. when the role was granted.';

COMMENT ON TABLE "AuditLogs" IS 'Append-only business audit trail: who changed which record, from what to what (observability.md §1 — audit is not logging; logs rotate away, these rows are retained). UPDATE and DELETE are revoked from the application database role on this table.';
COMMENT ON COLUMN "AuditLogs"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "AuditLogs"."actor_type" IS 'Audience the actor belonged to: MEMBER, ADMIN or SYSTEM.';
COMMENT ON COLUMN "AuditLogs"."actor_id" IS 'Users.id or AdminUsers.id depending on actor_type, NULL for SYSTEM. Deliberately NOT a foreign key: an audit row must survive deletion of its actor (ADR-006, the one documented soft reference — no join is ever performed on it).';
COMMENT ON COLUMN "AuditLogs"."action" IS 'What happened, as "<entity>.<past-tense-verb>", e.g. application.approved. Vocabulary lives in src/constant/audit.constant.ts so the audit screen can enumerate it.';
COMMENT ON COLUMN "AuditLogs"."entity_name" IS 'Table name of the subject, e.g. Members. Soft reference, paired with entity_id.';
COMMENT ON COLUMN "AuditLogs"."entity_id" IS 'Primary key of the subject row. Soft reference — no FK, so the audit outlives the subject.';
COMMENT ON COLUMN "AuditLogs"."before_json" IS 'Subject''s relevant fields before the change, or NULL for a create. Only the fields that changed; never document contents, password hashes or tokens.';
COMMENT ON COLUMN "AuditLogs"."after_json" IS 'Subject''s relevant fields after the change, or NULL for a delete.';
COMMENT ON COLUMN "AuditLogs"."ip" IS 'Client IP the change came from, as seen after trust-proxy resolution. NULL for jobs.';
COMMENT ON COLUMN "AuditLogs"."user_agent" IS 'Client user-agent string, truncated by the caller. NULL for jobs.';
COMMENT ON COLUMN "AuditLogs"."request_id" IS 'Correlation id of the request that caused the change, matching the requestId in the application logs (observability.md §2). NULL for jobs with no request.';
COMMENT ON COLUMN "AuditLogs"."createdAt" IS 'Row creation timestamp (UTC) — when the audited action happened. This table has no updatedAt and no deletedAt by design: rows are never modified or removed.';

COMMENT ON TABLE "SystemSettings" IS 'One runtime-configurable setting. Values live here rather than in env so an admin can change them without a deploy; anything that is a secret stays in env and never appears here.';
COMMENT ON COLUMN "SystemSettings"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "SystemSettings"."key" IS 'Dotted machine key, e.g. notification.email_enabled. Unique; read by code, never by label.';
COMMENT ON COLUMN "SystemSettings"."value" IS 'The value as text. Always parse it through value_type — never assume the shape.';
COMMENT ON COLUMN "SystemSettings"."value_type" IS 'How to parse value: STRING, NUMBER, BOOLEAN or JSON.';
COMMENT ON COLUMN "SystemSettings"."group" IS 'Screen grouping for the settings UI, e.g. notification, billing.';
COMMENT ON COLUMN "SystemSettings"."description" IS 'What this setting controls and what changing it affects, shown as help text.';
COMMENT ON COLUMN "SystemSettings"."is_public" IS 'TRUE means safe to expose to unauthenticated frontends. Anything with operational or commercial sensitivity stays FALSE.';
COMMENT ON COLUMN "SystemSettings"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "SystemSettings"."updatedAt" IS 'Last modification timestamp (UTC).';

COMMENT ON TABLE "JobRuns" IS 'One execution of one scheduled job (observability.md §1) — the evidence that answers "did the nightly work actually run?". A missing row is as much a failure signal as a FAILED one.';
COMMENT ON COLUMN "JobRuns"."id" IS 'Surrogate key.';
COMMENT ON COLUMN "JobRuns"."job_name" IS 'Registered job identifier, e.g. notification.drain. Matches the name in src/jobs.';
COMMENT ON COLUMN "JobRuns"."started_at" IS 'When this execution started (UTC).';
COMMENT ON COLUMN "JobRuns"."finished_at" IS 'When it finished (UTC). NULL while running, or forever if the process died mid-job.';
COMMENT ON COLUMN "JobRuns"."status" IS 'RUNNING, SUCCESS or FAILED. Written RUNNING at start and replaced exactly once on exit.';
COMMENT ON COLUMN "JobRuns"."processed_count" IS 'How many items the run handled — notifications drained, rows pruned. 0 is a normal, healthy result for a sweep with nothing to do.';
COMMENT ON COLUMN "JobRuns"."error" IS 'Failure detail for a FAILED run: message only, never a stack trace or SQL.';
COMMENT ON COLUMN "JobRuns"."createdAt" IS 'Row creation timestamp (UTC).';
COMMENT ON COLUMN "JobRuns"."updatedAt" IS 'Last modification timestamp (UTC) — set when the run is finalised.';

