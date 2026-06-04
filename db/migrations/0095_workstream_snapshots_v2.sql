-- 0095: workstream snapshot triple + manifestation-payload-cache
--       (BACKPORT-01 from Lazing-V2 · 2026-05-23)
--       Renumbered from 0094 → 0095 because 0094 is already taken by BACKPORT-03
--       (recursive_plans) (Agent 3/8).
--
-- Source: lazing-wt/realtime-orchestrator-v2/packages/runtime/src/store/
--         migrations/015-streaming-snapshots.ts (slice DB + SURFACE-PERSIST).
--
-- Extends workstreams with:
--   Slice DB (Realtime V2):
--   - snapshot_json TEXT          — JSON payload with partialText, activeTool,
--                                   activeStep, manifestCoord, engineId, status.
--                                   Written by the streaming writer every 500-1500 ms
--                                   (INV-30 disconnect-survives).
--   - snapshot_at INTEGER         — ms-since-epoch of the last meaningful
--                                   update (NOT bumped on a dup-hash).
--   - snapshot_content_hash TEXT  — N10: sha256(canonical(snapshot)). Used
--                                   for the idempotency skip: same
--                                   hash = no-op.
--
--   Slice SURFACE-PERSIST:
--   - manifestation_payload TEXT  — N1-verbatim canonical-json of the operator-
--                                   confirmed surface payload. Powers re-open
--                                   without re-running the engine.
--   - manifestation_kind TEXT     — manifest-kind label (composer, plan-board,
--                                   pinned-question, …) for the hydration router.
--
-- N4 — we extend the EXISTING workstreams table additively, instead of
--      creating a second "swarm_workstreams" table.
--
-- Idempotent: ALTER TABLE ADD COLUMN duplicate-column errors are caught by the
-- statement-by-statement fallback in db/client.ts.

ALTER TABLE workstreams ADD COLUMN snapshot_json TEXT;
ALTER TABLE workstreams ADD COLUMN snapshot_at INTEGER;
ALTER TABLE workstreams ADD COLUMN snapshot_content_hash TEXT;
ALTER TABLE workstreams ADD COLUMN manifestation_payload TEXT;
ALTER TABLE workstreams ADD COLUMN manifestation_kind TEXT;

CREATE INDEX IF NOT EXISTS idx_workstreams_snapshot_at
  ON workstreams (snapshot_at);

CREATE INDEX IF NOT EXISTS idx_workstreams_manifestation_kind
  ON workstreams (manifestation_kind)
  WHERE manifestation_kind IS NOT NULL;
