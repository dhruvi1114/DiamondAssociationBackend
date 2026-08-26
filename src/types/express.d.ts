/// <reference types="multer" />
import type { ActorType } from '@constant/audit.constant';

declare global {
  namespace Express {
    /**
     * Who is making this request. Set by the authentication middleware in M1;
     * consumed in M0 by the request logger and the audit helper. `SYSTEM` is
     * used by jobs, which construct an actor without a request.
     */
    interface RequestActor {
      type: ActorType;
      id?: bigint;
      email?: string;
      isSuperAdmin?: boolean;
      /**
       * The LIVE permission set, read from the database by `authenticateAdmin`
       * (cached 60 s) — never the token's claim, which is only a hash. Present
       * for ADMIN actors only; members have no roles (rbac.md §5).
       */
      permissions?: string[];
      /** Role codes held, for display and for approval-stage scoping (M4). */
      roles?: string[];
    }

    interface Request {
      /**
       * Correlation id for this request — from `x-request-id` or generated.
       * On every log line for this request and echoed in the error envelope
       * (observability.md §2).
       */
      requestId?: string;

      /**
       * Exact bytes of the JSON body, captured by `express.json({ verify })`.
       * Gateway webhook signatures are computed over these bytes and
       * `express.json()` otherwise discards them (ADR-018).
       */
      rawBody?: Buffer;

      actor?: RequestActor;
    }
  }
}

export {};
