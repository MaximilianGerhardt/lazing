# Local Install — laz.ing

A step-by-step for running laz.ing (formerly `lazyOS`) on your own machine (macOS, Linux, WSL2). Aim: first login in **< 10 minutes**.

> If you already know what you're doing → `bash scripts/setup.sh` then `pnpm dev`.

## Prerequisites

| | min |
|---|---|
| **Node.js** | 20.x (LTS recommended). Use `nvm` / `asdf` / `volta`. |
| **pnpm** | latest. `corepack enable && corepack prepare pnpm@latest --activate` |
| **git** | any recent |
| **sqlite3** CLI | optional, for poking the DB |
| **tmux** | only if you want long-lived agent sessions (`pnpm dev:agent`) |
| **claude-code CLI** | optional, only if you want real Claude-Code spawns. `npm i -g @anthropic-ai/claude-code` |

## 1. Clone

```bash
git clone https://github.com/MaximilianGerhardt/lazing.git
cd lazing
```

## 2. Configure (optional — `setup.sh` does this for you)

You can skip straight to step 3: `setup.sh` creates `.env.local` and
**auto-generates** the three required secrets (`LAZYOS_AUTH_SECRET`,
`LAZYOS_CREDENTIAL_KEY`, `LAZYOS_ACCESS_CODE`) with `crypto.randomBytes`, and
defaults `LAZYOS_OWNER_EMAIL` to `owner@localhost`. Real values are never
overwritten, so the step is idempotent.

To use your own values instead, set them before running setup — either edit
`.env.local`, or export them:

```bash
export LAZYOS_OWNER_EMAIL=you@example.com     # picked up by setup.sh
# (or copy cp .env.example .env.local and fill the REQUIRED block by hand)
```

| Variable | What | Generate |
|---|---|---|
| `LAZYOS_AUTH_SECRET` | HMAC for session cookies | auto, or `node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'` |
| `LAZYOS_CREDENTIAL_KEY` | AES-256-GCM key (64 hex) for creds at rest | auto, same command |
| `LAZYOS_ACCESS_CODE` | solo-self-host master-login code | auto |
| `LAZYOS_OWNER_EMAIL` | founder e-mail | defaults to `owner@localhost` |

Optional but recommended:

```bash
# magic-link mails — without these, the login flow falls back to console-log
RESEND_API_KEY=re_xxx
LAZYOS_EMAIL_FROM="laz.ing <you@mail.example.com>"
```

## 3. Setup

```bash
bash scripts/setup.sh
```

This runs (idempotently):
1. `pnpm install`
2. DB-migrations
3. Default-Org + Default-Workspace creation
4. Owner-User creation + founder membership

Re-running is safe — already-existing rows are skipped.

## 4. Start

```bash
pnpm dev          # web on http://localhost:4200
```

In a second terminal, if you want long-lived Claude-Code sessions:
```bash
pnpm dev:agent    # agent-server on http://localhost:4201
```

## 5. First login

Open `http://localhost:4200/login`.

Two paths:

**a) Magic-Link (mit Resend konfiguriert)**
- Type `LAZYOS_OWNER_EMAIL` → click "Login-Link senden".
- Click the link in the mail.
- Land in the onboarding wizard.

**b) Solo-Self-Host (ohne Mail)**
- Click the "Solo-Self-Host" tab on the login page.
- Paste `LAZYOS_ACCESS_CODE`.
- Direct landing in the app.

## 6. Verify

- TopNav shows the workspace switcher with "default".
- `/orgs` lists "Eigenprojekte" with one card.
- `/workspaces` shows "default".
- Chat works (sends to either system-shared MAX-plan or your own `.credentials.json`).

## Common issues

### "ENV-Variable XXX fehlt"
You skipped step 2. Fill all four required variables in `.env.local`.

### "no-founder" on master-login
DB has no founder yet. Run `bash scripts/setup.sh` first.

### Mails don't arrive
Without `RESEND_API_KEY`, magic-links go to the server console. Either:
- Watch `pnpm dev` output and copy the URL, or
- Configure Resend (`RESEND_API_KEY` + `LAZYOS_EMAIL_FROM`), then verify your sending domain in the Resend dashboard.

### Port 4200 in use
Set `PORT=4201` (or whatever) in `.env.local`. Adjust `LAZYOS_BASE_URL` accordingly.

### Database file
By default lives at `~/.lazyos/lazyos.db`. To start fresh:
```bash
rm -rf ~/.lazyos
bash scripts/setup.sh
```

## Next steps

- VPS-deploy: `docs/install/vps.md`
- Push-Notifications: `docs/push-setup.md`
- Encryption deep-dive: `docs/encryption-setup.md`
- Architecture pointers: `README.md` + `/how` in the running app
