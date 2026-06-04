# laz.ing CLI (binary: `lazyos-cli`) — Agent-Side Command-Line Interface

> Project rebranded **lazyOS → laz.ing** on 2026-05-01. The binary name `lazyos-cli` is a code identifier and stays unchanged for compatibility.

**Audience:** laz.ing-internal. This tool is invoked by Claude-Code CLI sessions (and humans doing ops) to poke the laz.ing API without opening the browser.

## Why this exists

The agent-backend pivoted from the Claude-Agent-SDK (with a dedicated MCP server for tickets/heartbeat/routines) to the **Claude-Code CLI as the agent runtime** (see `server/workspace-session.ts`, Stream A'). Claude-Code has Read/Write/Edit/Bash/Grep/Glob/WebFetch/WebSearch natively, but it has no idea that laz.ing concepts — tickets, workspaces, routines, heartbeat, push — even exist.

Rather than re-implement an MCP server (expensive, fragile handshakes), we expose those concepts as a plain CLI. Claude reaches them via its existing `Bash` tool. The system-prompt append inside `workspace-session.ts` teaches Claude what commands are available per workspace.

```
User ──chat──▶ Next.js (SSE) ──stream──▶ claude (Claude-Code CLI)
                                              │
                                              ├── Read/Write/Edit/Bash (native)
                                              └── Bash: `lazyos-cli ...` ──HTTP──▶ Next.js /api/*
```

## Install

```bash
pnpm install   # if not already
bash /opt/lazyos/scripts/install-cli.sh
```

This drops a wrapper at `/usr/local/bin/lazyos-cli` that `exec`s the project's pinned `tsx` against `scripts/lazyos-cli.ts`. Idempotent; re-run after edits to the source script (no re-install needed — the wrapper just runs the file).

## Authentication

The CLI sends `Authorization: Bearer <token>` against the laz.ing Next.js app. The middleware accepts that bearer on **`/api/*` paths only**; HTML pages still need a session cookie.

Token resolution order:

1. `$LAZYOS_CLI_KEY`
2. `$LAZYOS_CHAT_KEY`
3. `${HOME}/.lazyos/agent.env` — parses `KEY=VALUE` lines

Both env vars must be ≥ 16 chars or they're rejected. `LAZYOS_CLI_KEY` is the preferred knob once you want to rotate independently of the chat-backend key; for bootstrap they default to the same value.

**Server-side config required:**

- `/opt/lazyos/.env.local` (read by `next dev` / `next start`) — add `LAZYOS_CHAT_KEY` and `LAZYOS_CLI_KEY`.
- `${HOME}/.lazyos/agent.env` (read by `lazyos-agent.service`) — already holds `LAZYOS_CHAT_KEY`; add `LAZYOS_CLI_KEY` for symmetry.
- Vercel: mirror both env vars into the project's Production + Preview env.

## Target URL

`$LAZYOS_BASE_URL`, defaults to `http://127.0.0.1:4200` (local VPS Next-server). Override to hit a tunnel URL or Vercel deploy for remote testing.

## Command reference

### Tickets

```bash
# Create
lazyos-cli ticket create <workspace> "<title>" \
  [--body="..."] [--priority=P1] [--due=2026-05-01] \
  [--tags=backend,urgent] [--assignee=maxi]

# List — filter by workspace + status
lazyos-cli ticket list \
  [--workspace=<id>] \
  [--status=open|done|danger|wait|all] \
  [--query="..."] [--limit=50] [--offset=0]

# Single ticket
lazyos-cli ticket get <id>

# Update arbitrary fields
lazyos-cli ticket update <id> \
  [--status=...] [--body=...] [--priority=...] \
  [--title=...] [--due=...] [--tags=...]

# Close (soft-delete; emits `ticket.closed` event)
lazyos-cli ticket close <id>

# Event-sourced history
lazyos-cli ticket timeline <id>
```

**Priority values:** `P0` (deal-breaker) · `P1` (important) · `P2` (nice-to-have) · `P3` (backlog).

**Status values:** `open` · `done` · `danger` (blocked) · `wait` (awaiting input).

### Workspaces

```bash
lazyos-cli workspace list
lazyos-cli workspace get <id>
```

### Heartbeat

```bash
lazyos-cli heartbeat status
```

Returns the latest `/api/heartbeat/status` snapshot (last tick, pending alerts, etc.).

### Routines

```bash
lazyos-cli routine list
lazyos-cli routine trigger <id>
```

`trigger` fires a routine on-demand (ignoring cron schedule). The server response includes run-id for later inspection.

### Push notifications

```bash
lazyos-cli push send "<title>" "<body>" \
  [--url=/tickets/<id>] [--tag=ticket-created]
```

Sends a Web-Push to every stored subscription. Stale subscriptions (410/404 from provider) are pruned automatically server-side.

## Output format

**Success:** JSON on stdout, exit code 0. Shape matches the HTTP response body directly (no unwrapping).

**Error:** JSON on stderr of shape `{"ok": false, "error": "<code>", "message": "<human>"}`, exit code 1. Common codes:

| code | meaning |
|------|---------|
| `missing_args` | required positional/flag not supplied |
| `unknown_command` / `unknown_subcommand` | typo at the top-level or sub-command |
| `no_bearer_token` | neither env nor agent.env yielded a token |
| `http_<status>` | upstream returned a non-2xx (body attached) |
| `network_error` | fetch threw (DNS, connection refused, timeout) |
| `not_found` | client-side 404 (e.g. `workspace get` on unknown id) |
| `unhandled_error` | anything else — report this |

## Examples — as Claude will see them

```
$ lazyos-cli ticket create lazyos "Test aus CLI" --priority=P2 --body="Smoke-Test"
{
  "ticket": {
    "id": "TCK-01HZ...",
    "workspaceId": "lazyos",
    "title": "Test aus CLI",
    "status": "open",
    "prio": "P2",
    "createdAt": 1761235200000
  },
  "url": "/tickets/TCK-01HZ..."
}
```

```
$ lazyos-cli ticket list --workspace=lazyos --status=open
{
  "tickets": [ { "id": "TCK-...", "title": "...", "status": "open", ... } ],
  "pagination": { "limit": 50, "offset": 0, "count": 3 }
}
```

## System-prompt integration

`server/workspace-session.ts:buildLazyosSystemPrompt()` constructs a short workspace-aware block and passes it via `claude --append-system-prompt`. That teaches Claude:

- which workspace id it's in (substituted)
- which commands exist + example invocations
- behavioural rules ("if user says 'leg ein Ticket an' → create immediately")

Keep the block **short** — every token is charged per turn. Changing it requires bouncing the agent-server (`systemctl restart lazyos-agent`) to pick up the new text on fresh sessions; existing sessions carry the old prompt until `/session/restart`.

## Smoke-test

```bash
# 1. Check the wrapper is installed and finds tsx
lazyos-cli --help

# 2. Workspace list — trivial GET that exercises auth + middleware
lazyos-cli workspace list | head -20

# 3. Round-trip ticket
TICKET_JSON=$(lazyos-cli ticket create lazyos "Smoke-Test $(date -u +%FT%TZ)" --priority=P2)
TICKET_ID=$(echo "$TICKET_JSON" | jq -r '.ticket.id')
lazyos-cli ticket get "$TICKET_ID"
lazyos-cli ticket close "$TICKET_ID"

# 4. Inside a workspace session — attach and issue a chat prompt
tmux attach -t lazyos-ws-lazyos     # or use the web chat
# then type: "Leg ein Ticket an: Test vom System-Prompt-Append"
# Expect: Claude calls `lazyos-cli ticket create lazyos "Test vom System-Prompt-Append" ...`
```

## Out of scope

- **True MCP protocol.** We'd need to run a stdio-framed MCP server, pipe it into Claude-Code via `--mcp-config`, and maintain a second set of tool-schemas. Not worth it for these few verbs.
- **Write-through to VPS from Vercel.** Ticket POST still lands in the Vercel-local SQLite (ephemeral). Read-path is bridge-consistent; write proxy is the known Sprint-3 gap and already tracked.
- **Credential rotation automation.** Rotate by hand: update `.env.local` + `agent.env` + Vercel env, then `systemctl restart lazyos-agent` and redeploy web.
