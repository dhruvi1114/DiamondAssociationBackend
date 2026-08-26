-- A member's document version is unique per FACE, not per type.
--
-- `20260825140000_m5_dynamic_document_types_and_sides` introduced two-sided
-- documents and updated `ApplicationDocuments` accordingly, but left
-- `MemberDocuments_version_key` on (member_id, document_type_id, version) —
-- ignoring `side`. The upload path in `document.service.ts` has always computed
-- the next version per (member, type, SIDE), so a member uploading the FRONT and
-- then the BACK of one trade licence produced two rows at version 1 and the
-- insert failed with a raw P2002.
--
-- Nothing had hit it because member-side KYC upload is not yet in daily use;
-- copying approved applications' documents onto member records surfaced it
-- immediately, on the first two-sided document in the backlog.
--
-- Matches the shape `ApplicationDocuments` already uses.

DROP INDEX IF EXISTS "MemberDocuments_version_key";

CREATE UNIQUE INDEX "MemberDocuments_version_key"
  ON "MemberDocuments" (member_id, document_type_id, side, version) WHERE "deletedAt" IS NULL;
