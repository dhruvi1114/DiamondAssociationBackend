/**
 * Who performed an audited action (`AuditLogs.actor_type`, database-design.md §G).
 * `SYSTEM` covers scheduled jobs and webhook-driven changes, which have no
 * human actor but still change business records.
 */
export const ACTOR_TYPES = {
  MEMBER: 'MEMBER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
} as const;

export type ActorType = (typeof ACTOR_TYPES)[keyof typeof ACTOR_TYPES];

/**
 * Audit action vocabulary, `<entity>.<past-tense-verb>`.
 *
 * M0 only owns the cross-cutting ones; each later cycle appends its own.
 * Keeping them here rather than as inline strings means the audit report screen
 * (M10) can enumerate every action that exists.
 */
export const AUDIT_ACTIONS = {
  DOCUMENT_DOWNLOADED: 'document.downloaded',
  NOTIFICATION_QUEUED: 'notification.queued',
  NOTIFICATION_FAILED: 'notification.failed',
  SETTING_UPDATED: 'setting.updated',

  // --- M1: authentication (rbac.md §1, M1 definition of done) ---------------
  /** A member account was created by the public signup form. */
  USER_SIGNED_UP: 'user.signed_up',
  /** A signup OTP was accepted and the account moved to ACTIVE. */
  USER_EMAIL_VERIFIED: 'user.email_verified',
  /** Successful sign-in, either audience. */
  AUTH_LOGIN_SUCCEEDED: 'auth.login_succeeded',
  /**
   * Failed sign-in. Written for a wrong password AND for a login attempt
   * against an unknown address — the latter with a NULL entity_id, because the
   * pattern of attempts is the signal even when no account matches.
   */
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  /** The failure counter reached its limit and the account was time-locked. */
  AUTH_ACCOUNT_LOCKED: 'auth.account_locked',
  /** A sign-in was refused because the account is still inside its lock window. */
  AUTH_LOGIN_BLOCKED: 'auth.login_blocked',
  /** Explicit sign-out. `after.scope` is `session` or `all`. */
  AUTH_LOGGED_OUT: 'auth.logged_out',
  /** A refresh token was rotated. */
  AUTH_TOKEN_REFRESHED: 'auth.token_refreshed',
  /** A presented refresh token did not resolve to a live session. */
  AUTH_TOKEN_REJECTED: 'auth.token_rejected',
  /** Password changed by the account holder, who supplied the current one. */
  AUTH_PASSWORD_CHANGED: 'auth.password_changed',
  /** A reset link was requested (written only when an account actually matched). */
  AUTH_PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  /** A reset link was consumed and the password replaced. */
  AUTH_PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',

  // --- M1: RBAC administration ----------------------------------------------
  /** A staff account was created. */
  ADMIN_USER_CREATED: 'admin_user.created',
  /** A staff account's profile or status was edited. */
  ADMIN_USER_UPDATED: 'admin_user.updated',
  /** A role was granted to a staff account. */
  ADMIN_USER_ROLE_ASSIGNED: 'admin_user.role_assigned',
  /** A role was withdrawn from a staff account. */
  ADMIN_USER_ROLE_REVOKED: 'admin_user.role_revoked',

  // --- M2: membership catalogue ---------------------------------------------
  /** A membership category was created. */
  CATEGORY_CREATED: 'membership_category.created',
  /** A membership category was edited or (de)activated. */
  CATEGORY_UPDATED: 'membership_category.updated',
  /** A membership category was soft-deleted. */
  CATEGORY_DELETED: 'membership_category.deleted',
  /** A tier was created inside a category. */
  TIER_CREATED: 'membership_tier.created',
  /** A tier was edited or (de)activated. */
  TIER_UPDATED: 'membership_tier.updated',
  /** A tier was soft-deleted. */
  TIER_DELETED: 'membership_tier.deleted',
  /**
   * A price was published. Fee rows are the association's price list, so every
   * one of these is a financial decision and is retained as such.
   */
  FEE_CREATED: 'fee_structure.created',
  /** A price was closed, deactivated or annotated. Amounts are never edited in place. */
  FEE_UPDATED: 'fee_structure.updated',
  /** A document type was created. */
  DOCUMENT_TYPE_CREATED: 'document_type.created',
  /** A document type was edited or (de)activated. */
  DOCUMENT_TYPE_UPDATED: 'document_type.updated',
  /** A document type was soft-deleted. */
  DOCUMENT_TYPE_DELETED: 'document_type.deleted',

  // --- M5: registration masters --------------------------------------------
  COMPANY_TYPE_CREATED: 'company_type.created',
  COMPANY_TYPE_UPDATED: 'company_type.updated',
  COMPANY_TYPE_DELETED: 'company_type.deleted',
  EVENT_TYPE_CREATED: 'event_type.created',
  EVENT_TYPE_UPDATED: 'event_type.updated',
  EVENT_TYPE_DELETED: 'event_type.deleted',
  COUNTRY_CREATED: 'country.created',
  COUNTRY_UPDATED: 'country.updated',
  COUNTRY_DELETED: 'country.deleted',
  STATE_CREATED: 'state.created',
  STATE_UPDATED: 'state.updated',
  STATE_DELETED: 'state.deleted',
  CITY_CREATED: 'city.created',
  CITY_UPDATED: 'city.updated',
  CITY_DELETED: 'city.deleted',

  // --- M3: member record, KYC ------------------------------------------------
  /** A DRAFT company record was auto-provisioned for a signed-up login (ADR-016). */
  MEMBER_CREATED: 'member.created',
  /** The member edited a field they own outright. */
  MEMBER_PROFILE_UPDATED: 'member.profile_updated',
  /** Staff edited a member record directly. */
  MEMBER_UPDATED_BY_ADMIN: 'member.updated_by_admin',
  /** The member asked to change an identity field; an approver must decide. */
  MEMBER_CHANGE_REQUESTED: 'member.change_requested',
  /** A change request was approved and applied. */
  MEMBER_CHANGE_APPROVED: 'member.change_approved',
  /** A change request was refused, with remarks. */
  MEMBER_CHANGE_REJECTED: 'member.change_rejected',
  /** Membership class or band changed by staff, with a reason. */
  MEMBER_CATEGORY_CHANGED: 'member.category_changed',
  /** Membership status moved — activate, suspend, reactivate, expire, terminate. */
  MEMBER_STATUS_CHANGED: 'member.status_changed',
  /** A contact person was added. */
  MEMBER_CONTACT_ADDED: 'member_contact.added',
  /** A contact person was edited. */
  MEMBER_CONTACT_UPDATED: 'member_contact.updated',
  /** A contact person was removed. */
  MEMBER_CONTACT_REMOVED: 'member_contact.removed',
  /** An address was added. */
  MEMBER_ADDRESS_ADDED: 'member_address.added',
  /** An address was edited. */
  MEMBER_ADDRESS_UPDATED: 'member_address.updated',
  /** An address was removed. */
  MEMBER_ADDRESS_REMOVED: 'member_address.removed',
  /** A KYC file was uploaded, or re-uploaded as a new version. */
  DOCUMENT_UPLOADED: 'document.uploaded',
  /** A KYC file was accepted by staff. */
  DOCUMENT_VERIFIED: 'document.verified',
  /** A KYC file was refused by staff, with remarks. */
  DOCUMENT_REJECTED: 'document.rejected',
  /** A member removed an upload nobody had verified yet. */
  DOCUMENT_DELETED: 'document.deleted',

  // --- M4: application, approval, activation, billing ------------------------
  /** An applicant started a draft application. */
  APPLICATION_STARTED: 'application.started',
  /** An application was submitted or resubmitted for review. */
  APPLICATION_SUBMITTED: 'application.submitted',
  /** The applicant withdrew before a decision. */
  APPLICATION_WITHDRAWN: 'application.withdrawn',
  /** A reviewer passed an application at a non-final stage. */
  APPLICATION_STAGE_APPROVED: 'application.stage_approved',
  /** A reviewer approved at the final stage — the membership now exists. */
  APPLICATION_APPROVED: 'application.approved',
  /** A reviewer refused the application, with remarks. */
  APPLICATION_REJECTED: 'application.rejected',
  /** A reviewer sent it back for correction, with remarks. */
  APPLICATION_RETURNED: 'application.returned',
  /** A reviewer moved it to a different stage without deciding. */
  APPLICATION_REASSIGNED: 'application.reassigned',
  /**
   * The applicant edited a flagged field through the login-free correction link.
   * Distinct from `application.submitted` because it happens with no session
   * behind it — the actor is the application's own user row, identified by a
   * token rather than by a password (reject-resubmit spec D-9).
   */
  APPLICATION_CORRECTED: 'application.corrected',
  /** A new correction link was issued — on rejection, or on a "resend" request. */
  APPLICATION_LINK_REISSUED: 'application.link_reissued',
  /** A super admin cleared the resubmission counter, with a reason (D-13). */
  APPLICATION_RESUBMISSIONS_RESET: 'application.resubmissions_reset',
  /**
   * A super admin reopened a CLOSED application (D-18).
   *
   * Deliberately not the same action as the counter reset. A reset gives an
   * applicant attempts back on an application still in their hands; this one
   * reverses a decision that had already been taken and communicated, which is
   * the rarer and more serious event — and an audit report that cannot tell the
   * two apart cannot answer "who un-rejected this".
   */
  APPLICATION_REOPENED: 'application.reopened',
  /**
   * A finally-rejected applicant applied again on the same login (D-19).
   *
   * Written against the NEW application. The rejected one stays on record
   * untouched, so the pair of rows is the whole story: refused on this date,
   * tried again on that one, same `Users` row throughout.
   */
  APPLICATION_REAPPLIED: 'application.reapplied',
  /**
   * The moment a form became a member: code issued, term opened, invoice raised.
   * Written by the activation transaction, so its presence proves all three
   * happened together.
   */
  MEMBER_ACTIVATED: 'member.activated',
  /** An invoice was raised. */
  INVOICE_ISSUED: 'invoice.issued',
  /** An invoice was voided before payment. */
  INVOICE_CANCELLED: 'invoice.cancelled',
  /** An invoice was recorded as paid (offline payment). */
  INVOICE_PAID: 'invoice.paid',
  /** A receipt was generated for a paid invoice. */
  RECEIPT_ISSUED: 'receipt.issued',
  /** A membership term was opened. */
  TERM_CREATED: 'membership_term.created',

  // --- M7: company team logins ----------------------------------------------
  /** An owner invited someone onto the company roster. */
  MEMBER_TEAM_INVITED: 'member_team.invited',
  /** An owner switched a team login on or off. */
  MEMBER_TEAM_STATUS_CHANGED: 'member_team.status_changed',

  // --- M7: events -----------------------------------------------------------
  /** A draft event was created. */
  EVENT_CREATED: 'event.created',
  /** An event's details or price table were edited. */
  EVENT_UPDATED: 'event.updated',
  /** An event went live to its audience. */
  EVENT_PUBLISHED: 'event.published',
  /** An event was called off. */
  EVENT_CANCELLED: 'event.cancelled',
  /** An event with no registrations was removed. */
  EVENT_DELETED: 'event.deleted',
  /** Someone booked seats at an event. */
  EVENT_REGISTERED: 'event_registration.created',
  /** Staff approved a booking on an event that vets its attendees. */
  EVENT_REGISTRATION_APPROVED: 'event_registration.approved',
  /** Staff refused a booking. */
  EVENT_REGISTRATION_REJECTED: 'event_registration.rejected',
  /** A booking was called off, by the booker or by staff. */
  EVENT_REGISTRATION_CANCELLED: 'event_registration.cancelled',
  /** An unpaid hold ran out and its seats went back. */
  EVENT_REGISTRATION_EXPIRED: 'event_registration.expired',
  /** A payer said they had paid, and gave a reference. */
  PAYMENT_SUBMITTED: 'payment_submission.created',
  /** Staff confirmed the money landed. */
  PAYMENT_VERIFIED: 'payment_submission.verified',
  /** Staff could not find the money and said why. */
  PAYMENT_SUBMISSION_REJECTED: 'payment_submission.rejected',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
