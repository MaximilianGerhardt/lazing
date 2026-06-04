# Surface overview — laz.ing chat

As of 2026-05-02, after the 35→17 surface consolidation. A user-friendly overview
of every card that can appear in the chat stream.

## What is a surface?

A surface card is a structured response from the system in the chat — not a plain
text message, but an interactive component with its own logic. Examples: a ticket,
an approval request, a live pipeline tracker.

## The 4 clusters (after the wave-7 consolidation)

### Cluster A — `<surface:workflow>` (multi-stage operations)
A single card that transforms through phases instead of producing 4 separate cards.

**Phases:** intake → plan → dispatch → execute → review → done

**When does it appear?**
- You have an idea/task → the system plans + delegates
- A multi-tier loop is running (senior-dev → reviewer → critic)
- A V1 → V2 → V3 iterate-sniper loop

**What do you see?**
- Phase pill (top left): "plan", "dispatch", "execute", etc.
- Lanes/steps: one tracking element per tier
- Sub-tickets: when dispatch is active
- Final synthesis: when phase = done

### Cluster B — `<surface:prompt>` (user input)
Cards that ask for your input.

**Variants:**
- `form` — a structured multi-field form
- `credential` — API-key entry (encrypted)
- `decision` — a binary/multi decision
- `quickchoice` — a button row with 2–5 options
- `questions` — open questions with answer buttons

**When does it appear?**
- The system needs additional info (e.g. a missing API key)
- A plan has open questions
- An approval decision is needed

### Cluster C — `<surface:agent-step>` (sub-agent activity)
Makes visible what is running in the background.

**Modes:**
- `single` — a single-agent card
- `swarm` — 3+ parallel spawns with live output
- `tier-pick` — an Opus/Sonnet/Haiku choice
- `loop` — an auto-dispatch phase banner (3-tier loop)
- `bug-fix` — 3 parallel diagnosis models (new with the bug-fix pipeline)

**When does it appear?**
- A sub-spawn is running live
- A bug-fix-swarm diagnosis
- Tier-output aggregation

### Standalone (no cluster, its own domain anchor)
- **`milestone`** — a done summary in an Apple-keynote style after synthesis
- **`consensus-action`** — a consensus conflict with cluster choices (the user decides)
- **`sub-workstreams`** — a first-class sub-plan list with a live token counter
- **`ticket`** — a ticket card with status/priority/due date
- **`reasoning-audit`** — a trail card with drift status (verified/drift/fabricated)
- **`approval`** — an approval request
- **`rate-limit-retry`** — a recovery card on an Anthropic TPM throttle
- **`document`/`folder`/`cloud-browser`** — cloud documents
- **`invoice`** — an invoice layout

## The max-3-active-cards rule

Per **workstream**, at most 3 live (non-archived) cards are visible in the stream.
The oldest are archived automatically when a 4th card arrives. Parallel workstreams
each have 3 cards (3 workstreams × 3 = up to 9 cards).

## Persistence pattern

Cards with the same **coord** (workspaceId + workstreamId + surfaceKind + an
optional discriminator) are **upserted** instead of being rendered multiple times.
No card duplicates on re-mount.

## When do you not see a card?

- The server only emitted a plain-text response (no surface tag)
- The surface renderer rendered a fallback case
- The cap limit kicked in (the oldest card was archived)
- The surface was filtered by the privacy gate (a high-sensitivity workspace)

## Inspector

In the **/lab** showcase URL you can see every surface type:
- **Live tab** — how the card looks with mock data
- **Refactored tab** — the token-bound version
- **Real-Use tab** — a real, anonymized event from your DB
- **Diff tab** — the inline-style-hits finding
- **Tokens tab** — the CSS vars in use
- **Spring-Compare tab** — a CSS vs. motion-library animation comparison

## SOPs for server emission

- `event-to-surface.ts` maps events → surface tags
- `tier-orchestrator.ts` emits tags at 7 places (see grep)
- `emitOrUpdateCard` with loop coords for update-in-place
- `enforceActiveCap(prev, incoming, cap=3)` per workstreamId

More details: `docs/design-system-overview.md`, `docs/SURFACE-STYLE-GUIDE.md`.
