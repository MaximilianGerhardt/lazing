# Contributing to laz.ing

> The code identifier prefix `lazyos` (`lazyos-cli`, `LAZYOS_*` env, npm package name) is a legacy schema kept unchanged for compatibility behind the laz.ing brand.

Thanks for considering a contribution. This is a young, opinionated codebase. We optimize for **single-developer-per-task throughput** and **small, well-tested PRs**.

## Read this first — the Sniper-Principle

laz.ing is built around **mid-course correction as an architectural primitive**, not a feature. Whenever you propose a new phase, flow, or long-running operation, you must answer:

> *"Where can the human intervene without aborting the plan?"*

Concretely:

- **Long-running flows** (anything that takes > 5 seconds wall-clock) need an inject-point: a pause, a UI affordance, an event the user can grab.
- **Multi-step plans** (orchestrator chains, swarms, auto-dispatchers) need a hard cap (V5 in our iterate-loop, 3 re-synths in our swarm) — no infinite roast.
- **Approval-gated actions** (push, deploy, mass-mutation) need a single, undo-friendly point.
- **No silent retries** that could mask a user-correctable mistake.

If you're touching `server/agents/tier-orchestrator.ts`, `lib/workstreams/`, `app/workstreams/`, the spawn flow, or any auto-routine — the reviewer will explicitly ask: *"Where's the sniper-hook?"*

Existing examples in laz.ing:
- `runIterate` (V1→V5 with 25s pauses + `/api/workstreams/[id]/inject` + countdown UI)
- Swarm Re-Synthesis (Synthesis → pause → user can re-direct → up to 3 re-synths)
- Approval-FSM in tickets (`draft → review → approved → executed`)

Future patterns we want help with:
- **Phase RA** — Cross-Roast Sub-Plans → Master-Mapping (sub-tickets attack each other, lead-synth integrates back into master).
- **Phase IN** — Innovation-Button (UI region → KI rethinks → 3-5 mockups → user picks).

## Quickstart

```bash
git clone <fork> && cd lazyos
cp .env.example .env.local
# fill in: LAZYOS_AUTH_SECRET, LAZYOS_ACCESS_CODE, LAZYOS_CREDENTIAL_KEY,
#         LAZYOS_OWNER_EMAIL, LAZYOS_OWNER_DISPLAY_NAME
pnpm install
pnpm tsx scripts/lazyos-setup.ts   # first-boot
pnpm dev                            # web on 4200
```

In a separate terminal, if you need long-lived agent sessions (the agent server lives in `server/` with its own dependencies):
```bash
cd server && pnpm install && pnpm start   # agent server on 4201
```

## Branching + commits

- Branch from `main`. Naming: `feat/<short>` or `fix/<short>` or `chore/<short>`.
- Commits in present tense, ≤ 72 chars summary line. Bonus: include phase code (`Phase AU.3 — onboarding wizard`).
- Squash-merge by default. Only keep multiple commits if they describe genuinely independent steps.

## Code style

- TypeScript **strict mode**. No `any` — use `unknown` and narrow.
- Functional React components. Server Components by default; `"use client"` only when state/effects are needed.
- Validation at the boundary: Zod on incoming JSON, narrow types inside.
- Server-only modules (DB, fs, crypto): keep them out of components/hooks. Use server-component data-loading or thin route handlers.
- File comments: short header explaining *why* the file exists. Don't restate function names.
- Don't add libraries unless they unlock a clear capability. Prefer tightening what's there.

## Tests + checks before pushing

```bash
pnpm tsc --noEmit            # type-check (must pass)
pnpm lint:surfaces            # surface-style lint (must pass)
pnpm next build               # build (must pass)
```

Convenience: `pnpm lint:all` runs `tsc --noEmit` + `lint:surfaces` in one shot.

## Chat-Surface-Cards

Surface-Cards live under `lib/chat/*Card.tsx` and render rich, structured payloads in the chat stream. They have a **strict style discipline** — read `docs/SURFACE-STYLE-GUIDE.md` before touching one.

### Hard rules

- **No inline styles** for `borderRadius`, `fontSize`, `padding`, `margin` in `lib/chat/**/*Card.tsx`. Use the `.srf-{kind}` class system in `app/components.css` and bind to design tokens (`var(--radius-xl)`, `var(--dur-base)` etc.).
- **Pre-push linter**: run `pnpm lint:surfaces` locally before every push that touches a Card. CI will enforce it eventually; for now it's manual discipline.
- **Dynamic-style escape hatch**: if a value genuinely depends on runtime data (width per score, color per variant), use `// surface-lint-ignore` on the line above. The linter skips it. Don't abuse — the marker is for real dynamism, not for bypassing token discipline.
- **No husky auto-install** — we deliberately don't ship a pre-push hook. `pnpm lint:surfaces` is documented; running it is on you.

### Adding a new Surface kind — 4-step checklist

1. **Event-to-Surface mapping** — extend the type union in `lib/surfaces/types.ts` (or whichever entry-point your kind enters from). The agent-server and event-router need to know about it.
2. **SurfaceRenderer case** — add a `case 'your-kind':` in `lib/chat/SurfaceRenderer.tsx` that delegates to your new Card component.
3. **Card component** — create `lib/chat/{Kind}Card.tsx` as a Server Component (or `"use client"` only if interactive). Use `className="srf-{kind} srf-{kind}__..."` exclusively, no inline styles for layout.
4. **CSS class** — add the matching `.srf-{kind}` block in `app/components.css`, plus the kind name in the `prefers-reduced-motion` block at the top of the SRF section. Use existing tokens (`--radius-xl`, `--spring-bouncy`, `--dur-base`); if a token is missing, propose it in `app/globals.css` rather than hardcoding.

### Reference

- **Style Guide**: [`docs/SURFACE-STYLE-GUIDE.md`](docs/SURFACE-STYLE-GUIDE.md) — Tokens, Bubble-Specs, iOS-Patterns, Apple-Pure-Checklist.
- **Linter source**: `scripts/audit-inline-styles.ts`.
- **Live preview**: `/lab/[kind]?tab=tokens` shows the tokens each Card uses. Handy for verifying after a refactor.

If your change touches database schema:
- Add a numbered migration `db/migrations/0XXX_<topic>.sql` (idempotent: `IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` is fine — the loader handles re-run).
- Add the matching Drizzle schema update in `db/schema/<table>.ts`.
- Document the migration in `db/migrations/MIGRATION-NOTES.md` if it has gotchas.

If your change touches authentication:
- Run the security review checklist below mentally.
- Add an audit-log line via `writeAudit({...})` if it's a state-changing action.

If your change touches the chat / agent-server / spawn flow:
- Test it against a real running instance, not just unit-level. Phase MS taught us that streaming + multi-tab is hard to mock.

## Security review checklist (auth/crypto/secrets PRs)

- Timing-safe compare for any token/secret comparison (`lib/security/crypto.ts.timingSafeEqual`).
- Anti-enumeration on user-existence APIs (always return the same shape).
- Rate-limit any unauthenticated endpoint via the existing `lib/security/rate-limit.ts` policy.
- Encrypted-at-rest for any credential or token storage (`lib/security/credentials.ts.encryptCredential`).
- HttpOnly + Secure + SameSite=Lax on session cookies.
- Same-origin check on any state-mutating POST that takes a secret.

## What needs review

| Touch area | Required reviewer focus |
|---|---|
| Auth, sessions, magic link, bootstrap | Hacker mindset — race conditions, enumeration, replay |
| DB schema | Idempotent migrations, indices, foreign-key behavior |
| Frontend UX | Mobile + desktop manual test, no console errors |
| Agent-server (port 4201) | Real chat smoke test — multi-tab + reload + push |
| /how + docs | Wording matches code; both DE + EN if existing slug |

## Architecture

See `README.md` for the high-level overview, and `/how` once running for an in-product tour. Key entry points:

- `app/` — Next.js App Router routes
- `app/api/` — REST endpoints (Node runtime unless explicitly Edge)
- `lib/` — shared client+server logic (no `node:fs` in files imported by `'use client'` components)
- `server/` — long-running agent process (port 4201)
- `db/` — schemas + migrations
- `scripts/` — CLI scripts (setup, seed, deploy, watchdog)

## Issue + PR templates

Use the templates under `.github/`. Don't open PRs without a description — the reviewer needs the `why`.

## License

By contributing, you agree that your contributions will be licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later, see `LICENSE`).
