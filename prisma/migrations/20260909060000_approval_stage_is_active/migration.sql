-- An on/off switch for an approval stage.
--
-- Two of the three membership stages decide nothing today: no committee meets,
-- and the maker and the checker are the same super admin. They cannot be
-- deleted: "ApprovalRequests"."current_stage_id" and "ApprovalActions"."stage_id"
-- are both ON DELETE RESTRICT, so every decision ever recorded at a stage locks
-- its row -- and deleting would throw away the history that makes the day a
-- second reviewer joins a re-seed rather than a rebuild.
--
-- So the stage stays, switched off, and the engine skips it. "sequence" is not
-- renumbered: closing the gap would make the switch one-way.
--
-- DEFAULT true, so this migration changes no behaviour on its own. Which stages
-- are off is the seed's decision (prisma/seed/approvalWorkflow.ts), where it is
-- reviewable in code and re-asserted on every run.
ALTER TABLE "ApprovalStages" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN "ApprovalStages"."is_active" IS 'Whether this stage takes part in the flow. An inactive stage is SKIPPED, never deleted: the engine advances past it to the next active stage, its "sequence" is left un-renumbered so turning it back on restores its position, and every decision recorded at it stays readable. Applications already parked on a switched-off stage are not moved; they advance normally on the next approval. Deleting is not an option anyway — "ApprovalRequests"."current_stage_id" and "ApprovalActions"."stage_id" are ON DELETE RESTRICT (spec 2026-09-09-approval-stage-toggle D-1, D-3, D-4).';
