# ADR 0005 — Events vs. ledger: domain-event SSoT separate from N1 body storage

**Status:** accepted (non-negotiable)  
**Date:** 2026-05-20  
**Deciders:** maintainers (autonomous decision)

---

## Context

During integration work, the question arose whether domain events (e.g.
`workstream.created`, `step.completed`, `tool.call.allowed`) and the detail
ledger (N1 body storage for full payloads) are the same concept or must stay
separate.

**Two roles that must not be conflated:**

| Role | Table type | Writer | Main purpose |
|------|-----------|--------|--------------|
| Domain event (SSoT) | `*_events` | event bus / dispatcher | "What happened, when?" — lightweight, fast, indexable |
| Body storage (N1) | `*_ledger` | ledger repo (append-only) | "What was there verbatim?" — N1 truncation ban, content_hash N10 |

**Problem if mixed:**
- Event tables are designed for fast, lean rows (type + timestamp + reference
  ID). N1 forbids `.slice`/`.substring` on body strings — if events carry the
  body inline, the truncation ban is hard to enforce.
- Separate tables allow separate retention policies: events can be
  time-partitioned and archived; ledger rows are append-only and never deleted
  (the N1 archive).
- Event tables drive SSE streams and UI subscriptions (low latency). Ledger
  reads are rare and bulk (detail restore, audit).

**Locked position:** "events = domain-event SSoT, `*_ledger` = N1 body storage,
separate."

## Decision

**Events and ledger are architecturally separate concepts with separate tables
and write paths.**

Rules:
1. **Event tables** (`lazyos_events`, or typed variants like `workstream_events`)
   carry only: `id`, `type`, `created_at`, reference IDs (`workstream_id`,
   `workspace_id`, …) and a lean `meta` JSON field (max ~4 KB). No full body.
2. **Ledger tables** (`workstream_detail_ledger`, `chat_ledger`, …) carry the
   full payload verbatim. `content_hash = sha256(canonicalize(payload))` (N10).
   No `.slice`/`.substring` allowed (ESLint rule).
3. If a writer needs both (e.g. a tool call with a full input body):
   - Write the event (light) → get the `id` back.
   - Write the ledger (full) → get the `ledger_id` back.
   - The event gets `ledger_ref_id` as a foreign key — no body duplicate.
4. Cross-referencing via the `ledger://` resolver in the system prompt:
   `ledger://<table>/<id>` resolves to the full payload without copying the body
   into the context (N1-conformant).

**Current code state:**
- `lib/events/` — domain events present.
- `lib/chat/ledger.ts` + `db/schema/chat_ledger.ts` — chat_ledger **built and
  wired** (`app/api/chat/stream/route.ts` writes it; `server/db.ts` and
  `server/workspace-session.ts` use it). Status: **landed.**
- `lib-v1/workstreams/ledger/repo.ts` — workstream_detail_ledger **built, but not
  yet wired into the normal workstream dispatch path**. Status: **open.**
- The `ledger://` resolver in the system prompt — **not yet implemented**.

## Consequences

**Positive:**
- N1 enforcement becomes structurally enforceable through separation (ESLint
  `no-restricted-syntax` against `.slice/.substring` on the LedgerString brand).
- The event bus can scale/archive without touching the N1 ledger.
- The `ledger://` resolver keeps the system prompt lean (no body paste).
- Separate retention policies are possible.

**Negative / accepted:**
- Two writes instead of one for full events (slight overhead).
- The foreign key between the event and ledger tables must be kept consistent.

**Open items:**
- The `ledger://` resolver in `buildLazyosSystemPrompt` is not implemented.
- `lib-v1/workstreams/ledger/repo.ts` is not wired into dispatch.
- The LedgerString brand and ESLint rule are active, but coverage on
  workstream_detail_ledger still needs checking.

**Sources:**
- `CLAUDE.md` → operating constraints N1, N8, N10.
- `lib/chat/ledger.ts`, `lib-v1/workstreams/ledger/repo.ts`.
