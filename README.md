<div align="center">

# laz.ing

**A local-first AI agent runtime — steerable agents, mid-course correction, self-hosted.**

[Quickstart](#quickstart) · [What is laz.ing](#what-is-lazing) · [Features](#features) · [Architecture](#architecture) · [Configuration](#configuration) · [License](#license)

</div>

> **Note on naming:** the brand is **laz.ing**. The code identifier prefix `lazyos`
> (the `LAZYOS_*` environment variables, the `lazyos` package name, DB identifiers,
> systemd unit names) is a **legacy schema** kept unchanged for backward
> compatibility. Wherever you see `lazyos` in code or config, read "laz.ing".

---

## What is laz.ing?

laz.ing is a **self-hosted, browser-based runtime for AI agents**. It is not a
VS Code plugin and not a cloud SaaS — you run it on your own machine or your own
server, it stores everything in a local SQLite database, and it keeps AI work
**steerable after the work has started**.

You open a tab, throw in an idea, and a set of agents works on it in parallel.
You watch a plan take shape. Before the next iteration runs, the system pauses so
you can intervene, sharpen the direction, or change course — without throwing the
plan away. When the plan is approved, the system dispatches sub-tasks into their
own workstreams. Background routines run on a schedule, and (optionally) push
notifications tell you when something needs your approval.

The core idea is **mid-course correction as an architectural primitive**, not a
feature bolted on afterwards.

---

## Features

- **Multi-agent workstreams** — a lead agent drafts, a critic agent attacks, the
  result is integrated, iteration by iteration (hard-capped, no infinite loop).
- **Mid-course correction ("sniper") loop** — every long-running flow has an
  explicit pause + inject point so a human can redirect it mid-flight instead of
  aborting and restarting.
- **Local-first & self-hosted** — single Node process + SQLite. No cloud
  dependency required; bring your own LLM (Anthropic/OpenAI API key, a local
  Claude/Codex CLI plan, or a local Ollama model).
- **Multi-user with org/workspace hierarchy** — Organizations contain members
  and workspaces; each workspace has its own chat, tickets, files and branding.
- **Event-sourced audit trail** — state changes are recorded so decisions,
  sources and corrections are traceable, not just logged as telemetry.
- **Scheduled routines** — YAML-defined cron jobs for daily briefings,
  heartbeat checks and deadline watches.
- **Optional web push** — get approval prompts on your phone (VAPID).
- **First-run onboarding wizard** at `/oss-onboarding`.

---

## Quickstart

```bash
git clone https://github.com/MaximilianGerhardt/lazing.git
cd lazing

pnpm install

bash scripts/setup.sh   # auto-generates the required secrets, runs migrations,
                        # seeds the default org/workspace/owner. Idempotent.

pnpm dev                # web app on http://localhost:4200
```

`setup.sh` creates `.env.local` and **auto-generates** the three required secrets
(`LAZYOS_AUTH_SECRET`, `LAZYOS_CREDENTIAL_KEY`, `LAZYOS_ACCESS_CODE`); the owner
e-mail defaults to `owner@localhost`. To use your own values, set them first
(edit `.env.local` or `export LAZYOS_OWNER_EMAIL=…`) — real values are never
overwritten. It prints your solo-self-host login code at the end.

Optionally, in a second terminal, start the long-running agent server for
real CLI agent sessions (it lives in `server/` with its own dependencies):

```bash
cd server && pnpm install && pnpm start   # agent server on http://localhost:4201
```

Then open `http://localhost:4200`. On a fresh install you are taken through the
**first-run onboarding wizard** at [`/oss-onboarding`](http://localhost:4200/oss-onboarding):
it walks you through the owner profile, the first organization and the first
workspace.

**Logging in without e-mail:** set `LAZYOS_ACCESS_CODE`, choose the
solo-self-host option on the login page, and paste the code. With e-mail
configured (Resend), use the magic-link flow instead; without it, the magic link
is printed to the server console.

More detailed guides live under [`docs/install/`](docs/install/) —
[local](docs/install/local.md), [Docker](docs/install/docker.md) and
[VPS](docs/install/vps.md).

---

## Architecture

- **Stack:** Next.js 16 (App Router) · TypeScript (strict) · Drizzle ORM ·
  SQLite (Postgres optional) · React 19.
- **Event-sourced core:** state changes are appended to an event log that acts
  as the source of truth, with an audit trail over decisions and corrections.
- **Two processes:** the Next.js web app (default port `4200`) and an optional
  long-running agent server (default port `4201`) that hosts real CLI agent
  sessions.

Repository layout:

| Path | What |
|---|---|
| `app/` | Next.js App Router routes |
| `app/api/` | REST endpoints (Node runtime unless explicitly Edge) |
| `lib/` | Shared client + server logic (chat, workspaces, orgs, security, mail, tickets, workstreams, agents) |
| `server/` | Long-running agent process (port 4201) |
| `db/` | Drizzle schemas + idempotent SQL migrations |
| `scripts/` | One-shot CLIs (setup, seed, deploy, watchdog) |
| `docs/` | Install guides, architecture notes, ADRs |

There is also an in-product tour at `/how` once the app is running.

---

## Configuration

All configuration is via environment variables. Copy the template and fill it in:

```bash
cp .env.example .env.local
```

[`.env.example`](.env.example) documents every variable the shipped code reads,
grouped into **REQUIRED**, **PATHS**, **BRAND/MODE/RUNTIME**, **ENGINES/LLM**,
**AGENT SERVER**, **OPTIONAL INTEGRATIONS** (GitHub OAuth, e-mail, web push,
speech-to-text, VPS bridge) and **DEV/TEST ONLY**.

The four you must set for a working install:

| Variable | What |
|---|---|
| `LAZYOS_AUTH_SECRET` | HMAC secret for session cookies. >= 32 random bytes (hex). |
| `LAZYOS_ACCESS_CODE` | Operator bootstrap / solo-self-host login code. >= 16 chars. Treat like a root password. |
| `LAZYOS_CREDENTIAL_KEY` | AES-256-GCM key for credentials at rest. 64 hex chars. |
| `LAZYOS_OWNER_EMAIL` | Founder e-mail (used by the setup script). |

---

## Development

```bash
pnpm dev                          # web app on 4200
cd server && pnpm start           # agent server on 4201 (separate terminal)
pnpm tsc --noEmit                 # type-check
pnpm test                         # test suite
pnpm build                        # production build
pnpm start                        # production start
```

Ops unit templates for self-hosters (systemd timers/services, a macOS launchd
plist) live under [`systemd/`](systemd/), [`systemd-units/`](systemd-units/) and
[`launchd/`](launchd/). Adjust the install paths to your environment before use.

---

## License

Licensed under the **GNU Affero General Public License v3.0 or later**
([AGPL-3.0-or-later](LICENSE)). Because the AGPL covers network use, if you run a
modified version of laz.ing as a network service you must offer its source to
your users.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The guiding
rule for any new long-running flow: *"Where can a human intervene without
aborting the plan?"*

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Do not
open a public issue for security findings.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

---

<sub>Created by Maximilian Gerhardt · laz.ing · pre-1.0 · `lazyos` is the legacy code identifier behind the laz.ing brand.</sub>
