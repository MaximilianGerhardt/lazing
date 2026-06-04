# ADR 0003 — Substrate: extend workstreams, no parallel swarm_runs tables

**Status:** accepted (non-negotiable; N-constraint class)  
**Date:** 2026-05-10 · reaffirmed 2026-05-20  
**Deciders:** maintainers (architecture audit synthesis)

---

## Context

While merging work between earlier and later runtime versions, the question
arose whether new swarm/branch primitives should be introduced as their own
tables (`swarm_runs`, `swarm_branches`), or whether the existing
`workstreams + subdispatches` substrate should be extended.

**Finding from the architecture audit:**
- `workstreams` + `subdispatches` already cover swarm runs, branch trees and
  execution hierarchies adequately.
- A direct branching scheme (`swarm_runs`/`swarm_branches`) would create a
  parallel substrate that, in practice, models the same thing with different
  column names → duplicate write paths, duplicate schema overhead, eventual
  divergence.
- The existing `workstreams` schema has dozens of migrations of production
  substance behind it (tens of thousands of RAG chunks live, sub-org patches
  consistent against the live DB).

**Repair pass (authority tier 1):**
Explicitly recorded: "Substrate decision (V1): extend `workstreams` +
`subdispatches`. Do NOT introduce parallel `swarm_runs` / `swarm_branches`
tables — direct branch-tree tables are a Tier 2 migration triggered only when
`workstreams` blocks real branch-tree navigation."

## Decision

**`workstreams` and `subdispatches` are the only V1 substrate for swarm runs,
branch trees and execution hierarchies.**

Concretely:
- New columns are added additively to `workstreams` or `subdispatches`.
- New tables for swarm state are only allowed if they *complement* (e.g.
  `workstream_detail_ledger`, `workstream_evidence`, `workstream_decisions`,
  `workstream_injections`, `workstream_pauses`) — not if they duplicate the core
  substrate.
- Any migration PR that introduces `swarm_runs` or `swarm_branches` as new
  primary tables is rejected without merging.
- The Tier-2 migration (direct branch-tree tables) stays gated: only after an
  explicit owner go-ahead and after `workstreams` has demonstrably blocked
  branch-tree navigation.

**Complementary tables (explicitly allowed, canonical names):**
- `workstream_detail_ledger` — N1 body storage (no truncation)
- `workstream_evidence` — N8 same-workstream evidence row
- `workstream_decisions` — N8 decisions write
- `workstream_injections` — injection state
- `workstream_pauses` — explicit pause state machine

## Consequences

**Positive:**
- A single, uniform schema path → no duplicate write code.
- The migration order stays linear and reviewable.
- The production substance in `workstreams` is used, not bypassed.
- Conforms to the repair pass (authority tier 1).

**Negative / accepted:**
- The `workstreams` table grows with new columns; with very deep branch trees,
  self-join performance may become relevant (the Tier-2 trigger).
- If branch-tree navigation shows real problems, Tier 2 must be discussed — this
  ADR only blocks it for V1, not permanently.

**Open items:**
- Later migrations for `workstream_pauses`, `workstream_injections` and
  `workstream_decisions` are not yet written.

**Sources:**
- `CLAUDE.md` → substrate decision.
- The repair-pass and audit planning documents (owner-internal).
