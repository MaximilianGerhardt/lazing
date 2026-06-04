# ADR 0004 — Default permission mode: phase-1 FreeRein-with-audit → end state `lane`

**Status:** accepted  
**Date:** 2026-05-20  
**Deciders:** maintainers (autonomous decision)

---

## Context

lazyOS today runs the Claude CLI in tmux sessions with
`--permission-mode=acceptEdits` as the only engine mode — no fine-grained
permission model is active. With the introduction of the three-tier permission
model (FreeRein / Lane / Ask), the default mode and the migration path must be
decided.

**Locked position:** end-state default mode = `lane` (i.e. allow-list based, per
workspace).

**Open question:** a direct cutover to `lane`, or a 7-day diagnosis phase first?

**Problem with a direct cutover:**
- Existing workflows (bug-swarm, tier orchestrator, auto-dispatch) do not know
  their concrete tool allow-lists today — a direct cutover would likely break
  these workflows because the allow-list would be guessed rather than
  data-driven.

## Decision

**Two-phase migration sequence:**

### Phase 1 — FreeRein-with-audit (7-day diagnosis)
- Mode label: `freerein-with-audit`
- `--permission-mode=acceptEdits` is preserved (no enforcement).
- Every tool call is written to `lazyos_tool_audit`, but **not blocked**.
- Day 0: the audit write path is live. Days 1–7: collect telemetry.
- Goal: a data-driven per-workspace allow-list without disrupting production.

### Allow-list derivation (days 7–9)
- An aggregation script (purely analytical): reads `lazyos_tool_audit`, writes
  `lane-allowlist-YYYY-MM-DD.json`.
- Manual review by the operator (2 days): remove false positives, add missing
  patterns.

### Phase 2 — Lane (from day 10, default for new workspaces)
- Default mode = `lane`.
- Existing workspaces stay on `freerein-with-audit` until explicitly migrated.
- The `LAZYOS_PERMISSION_ENFORCEMENT=1` env flag turns enforcement on; default
  `0` → non-disruptive for existing installs.

**Current code state:**
- `lib-v1/permission/resolver.ts`, `lib-v1/permission/repo.ts`,
  `lib-v1/permission/constants.ts`, `lib-v1/permission/floor-patterns.ts`,
  `lib-v1/permission/tool-class-map.ts` — **built, but not yet wired into the
  tmux spawn init (`server/agents/tmux-spawn.ts`)**.
- Status: `lib-v1/permission/*` is **open / unwired**.

## Consequences

**Positive:**
- No production break during migration: the telemetry phase runs invisibly.
- The allow-list emerges from real usage data, not from estimates.
- The env flag makes enforcement switchable on/off at any time (N5-conformant).
- Reversible: `freerein-with-audit` at any time via a workspace setting.

**Negative / accepted:**
- 7–10 days of lead time before real enforcement.
- The `lazyos_tool_audit` table must be live before phase 1 starts.

**Open items:**
- `lib-v1/permission/*` must be wired into `server/agents/tmux-spawn.ts`.
- The allow-list derivation script is not yet written.
- The `LAZYOS_PERMISSION_ENFORCEMENT` env flag is not yet evaluated.

**Sources:**
- Internal decision log.
- `CLAUDE.md` → operating constraints N1–N11 (N5).
