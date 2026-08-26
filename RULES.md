### Backend Skeleton Engineering Rules

This project is a reusable Node.js/TypeScript/Express/Prisma backend skeleton. All new services based on this skeleton must follow these rules.

### Architecture

- **Layered design**: Follow **Controller → Service → Repository**.
  - **Controllers**: HTTP only – parse/validate requests, call services, map responses via `handleApiResponse`.
  - **Services**: Business rules, orchestration, error decisions (`AppError`).
  - **Repositories**: Data access only (Prisma).
- **Shared core**:
  - Use `AppError` + `ErrorHandler` for all error handling.
  - Use `handleApiResponse` / `handleErrorResponse` for all API responses.
  - Use constants from `src/constant` (`ERROR_TYPES`, `RES_TYPES`, `RES_STATUS`, `END_POINTS`).

### Data access (Prisma, performance) — hybrid read policy, ADR-005

> **Amended in M0.** The original skeleton rule was "all reads must use raw SQL". That
> cost type safety and velocity on trivial reads for no measurable benefit, so ADR-005
> replaces it with the split below. The performance intent is unchanged: list endpoints
> are still one parameterised SQL statement, still paginated, still N+1-free.

- **Point reads and simple relations → the typed Prisma client.**
  - `findUnique` / `findFirst` / `findMany` with a small `where` and an explicit `select`.
  - Use it when the query is "this row by id" or "these rows by one foreign key".
  - You keep compile-time column names and return types; use them.
- **List, search, report and dashboard reads → parameterised `$queryRaw`.**
  - Anything with joins, aggregates, window functions, dynamic filters or dynamic sorts.
  - **Always** `prisma.$queryRaw` with a tagged template or `Prisma.sql` — never string
    concatenation, and never an interpolated identifier that came from a request.
  - Sort and filter columns come from a per-endpoint **allowlist**; anything else is a
    422. An interpolated `ORDER BY ${req.query.sortBy}` is a SQL injection, not a feature.
  - Select only the columns the response needs, and always paginate (`limit` max 100,
    server-clamped) with `total` from a windowed count in the same statement.
- **Either way, the repository returns a typed DTO.** The service must not be able to
  tell which mechanism was used, so a query can be switched later without a ripple.
- **Raw SQL must double-quote identifiers** — tables are `PascalCasePlural` and columns
  are `snake_case` (ADR-003), so `FROM "Members" m WHERE m."gst_number" = $1`.
- **Soft-deleted tables**: every read filters `"deletedAt" IS NULL`. This is not optional
  and it is not automatic — Prisma has no global filter here.
- **Writes**:
  - `create` / `update` / `delete` may use the typed client, or raw SQL where a bulk or
    set-based operation genuinely needs it.
  - Multi-step changes run in `prisma.$transaction`, and any helper that participates
    (`writeAudit`, `queueNotification`, `generateDocumentNumber`) takes the caller's `tx`
    as its first argument. That is what makes ADR-010's "notification queued in the same
    transaction as the business change" true rather than aspirational.

### Database comments are mandatory (ADR-013)

Every table and every column in `public` carries a `COMMENT ON`. Prisma does not
propagate `///` doc-comments to PostgreSQL, so each migration has a mandatory second half:

```bash
npx prisma migrate dev --create-only --name m3_add_approval_tables
npx tsx scripts/emit-db-comments.ts ApprovalRequests ApprovalActions >> \
  prisma/migrations/<timestamp>_m3_add_approval_tables/migration.sql
npx prisma migrate dev
npm run db:check-comments      # gate — exits 1 on any gap, runs in husky pre-push
```

Comments live in the **same** migration that creates the object, never in a follow-up
"add comments" migration. Wording rules and the boilerplate for repeated columns
(`id`, `createdAt`, `deletedAt`, …) are in `docs/database-design.md` §I.

### Environment & builds

- Use **env flavors** via `APP_ENV`:
  - Supported values: `local`, `dev`, `staging`, `production`.
  - Maintain matching files: `.env.local`, `.env.dev`, `.env.staging`, `.env.production` (plus base `.env`).
  - The config loader reads base `.env` then overlays `.env.<APP_ENV>`.
- **Builds**:
  - Prefer `npm run build:interactive` when creating named builds.
    - The script will:
      - Ask **which branch** is being built.
      - Ask **which environment flavor** (`local`/`dev`/`staging`/`production`).
      - Ask for a short **build message/label**.
      - Run `npm run build` with the selected env.
      - Write `dist/build-info.json` with branch, flavor, message, timestamp, and commit hash.
  - Flavor-specific scripts:
    - `build:local`, `build:dev`, `build:staging`, `build:prod` must keep using `APP_ENV` and `NODE_ENV` consistently.

### Security & auth

- Always register **security middlewares** in `app.ts`:
  - `helmet` for headers.
  - `cors` restricted to `CORS_ORIGINS` — **never** `origin: '*'` (security.md §5). The
    config loader rejects `*` outright.
  - `express-rate-limit` — the global cap plus the named limiters in
    `middleware/security.ts` (`login`, `otp`, `publicSearch`) per api-conventions.md §9.
    A login route that inherits only the global cap is effectively unthrottled.
  - `app.set('trust proxy', TRUST_PROXY_HOPS)` so rate limiting and IP audit see the real
    client address behind nginx.
- **Payload encryption (ADR-004)** is obfuscation, not authorisation. `decryptPayload`
  runs before validation; authn, authz and zod still run on every request afterwards.
  The bypass list (multipart uploads, `/webhooks/**`, `/health*`) lives in exactly one
  place, `middleware/decryption.ts`, and is shared by the request and response paths.
- **JWT auth** (built in M1, per rbac.md §1/§2): two audiences, two middlewares —
  `authenticate` for members, `authenticateAdmin` for staff. `aud` is checked before any
  permission lookup, so a member token can never reach an admin route (ADR-002). Use
  `authorize('<module>.<action>')` for staff routes; the permission set is re-read from
  the database on every admin request, so a revoked permission takes effect immediately.
- **Never** log or return: passwords, hashes, tokens, OTPs, AES keys, decrypted payloads,
  KYC field values (IEC/GST/PAN/trade licence). The winston redaction denylist in
  `logger/redact.ts` is a backstop, not permission to be careless.
- **Cross-member access returns 404, never 403** — a 403 confirms the row exists and lets
  ids be probed (security.md §2).

### Validation, errors & logging

- **Request validation**:
  - Use `zod` schemas and `validateRequest` middleware for `body`, `query`, and `params`.
  - Do not manually validate in controllers; centralize via schemas.
- **Errors**:
  - Only throw `AppError` from services/controllers for expected errors.
  - `AppError` carries an **i18n key**, never a literal: `messageKey: 'application.notEditable'`.
    `ErrorHandler` resolves it against the caller's `lan` header, so one throw serves
    every locale. The `code` comes from `ERROR_TYPES`, which is the api-conventions.md §5
    table and drives the HTTP status.
  - Never send raw error stacks, SQL, Prisma messages or table names to clients; rely on
    `ErrorHandler`, which logs the internal detail and returns only the fixed shape.
- **Messages**: every user-facing string resolves through `src/locales/en.json` via a
  `<namespace>.<key>`. `handleApiResponse` takes `messageKey`, not `message`. A literal
  sentence in a controller or service is a review failure.
- **Logging**:
  - Use the shared `logger` from `src/logger/logger.ts`. It emits JSON lines, stamps the
    `requestId` from the async context onto every line, and recursively redacts the
    denylist before serialising.
  - Do not use `console.log`/`console.error` in application code (scripts and seeds may).

### Quality, accuracy, timely delivery

- **Quality**:
  - TypeScript must run in **strict** mode.
  - ESLint + Prettier must be green before merging (and pre-commit via Husky must pass).
  - Keep modules small, focused, and well-named.
- **Accuracy**:
  - All inputs validated; all domain rules captured in services.
  - Responses must use standardized shapes and message constants.
  - Prefer explicit, typed DTOs and return types.
- **Timely delivery**:
  - Reuse this skeleton and its patterns for new modules and services.
  - Avoid reinventing patterns – extend shared utilities and constants instead.
  - Favor small, incremental changes and PRs over large rewrites.

