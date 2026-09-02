import { Router } from 'express';
import { authenticateAdmin, authorize, validateRequest } from '@middleware';
import * as controller from '@modules/audit/audit.controller';
import { listAuditSchema } from '@modules/audit/audit.types';

/**
 * `/api/v1/admin/audit` — the audit trail (AJ-10, screen A-35).
 *
 * Read-only, and the router is the proof: there is no POST, PATCH or DELETE to
 * add later without someone noticing. `AuditLogs` is a business record, not a
 * log line — it is how the association answers "who changed this" long after the
 * application logs have rotated away.
 *
 * `audit.view` alone, with no `requireSuperAdmin` floor: unlike RBAC and system
 * settings, reading the trail changes nothing, and an ADMIN investigating a
 * disputed decision is the ordinary case rather than the dangerous one
 * (`rbac.md` §3 grants it to SUPER_ADMIN and ADMIN).
 *
 * Scoped with a path prefix rather than `router.use(...)` router-wide: this
 * router shares the `/admin` mount with masters, RBAC and settings, and a
 * blanket guard would 403 an ACCOUNTS admin on routes this file does not own.
 */
export const auditRouter = Router();

const AUDIT = '/audit';
const canView = [authenticateAdmin, authorize('audit.view')];

auditRouter.use(AUDIT, ...canView);

/**
 * Declared before the list route even though the paths do not collide: keeping
 * the literal above the parameterless list is the same habit that stops
 * `/applications/workflow` being swallowed by `/applications/:id`, and costs
 * nothing to keep.
 */
auditRouter.get(`${AUDIT}/facets`, controller.listFacets);

auditRouter.get(AUDIT, validateRequest({ query: listAuditSchema }), controller.listAuditLogs);
