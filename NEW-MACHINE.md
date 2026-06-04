# Testing laz.ing on a new machine

The shortest path from a bare machine to a running laz.ing with the first-run
onboarding wizard. Tested on macOS (Apple Silicon & Intel); the same steps work
on Linux/WSL2.

---

## 0. Prerequisites (one-time, ~2 min)

You need **git**, **Node ≥ 20**, and **pnpm**.

**macOS** (with [Homebrew](https://brew.sh)):

```bash
brew install git node            # Node 20+ ; git
corepack enable && corepack prepare pnpm@latest --activate   # pnpm
```

No Homebrew? Install Node from <https://nodejs.org> (LTS), then run the
`corepack …` line above. Verify:

```bash
node -v   # v20.x or newer
pnpm -v   # any recent
git --version
```

---

## 1. Get it running (one command + start)

```bash
git clone https://github.com/MaximilianGerhardt/lazing.git
cd lazing

pnpm install
bash scripts/setup.sh          # auto-generates secrets, migrates the DB,
                               # seeds the default org/workspace/owner
pnpm dev                       # web app → http://localhost:4200
```

`setup.sh` is idempotent and self-configuring:

- creates `.env.local` and **auto-generates** the three required secrets
  (`LAZYOS_AUTH_SECRET`, `LAZYOS_CREDENTIAL_KEY`, `LAZYOS_ACCESS_CODE`),
- defaults `LAZYOS_OWNER_EMAIL` to `owner@localhost` (override by exporting
  `LAZYOS_OWNER_EMAIL=you@domain.tld` before running it, or editing `.env.local`),
- runs all DB migrations against a local SQLite file,
- seeds the default org + workspace + owner user,
- prints your **solo-self-host login code** at the end.

> Want a different owner e-mail? `export LAZYOS_OWNER_EMAIL=you@domain.tld`
> before `setup.sh`. Real values in `.env.local` are never overwritten.

### Optional: the agent server (real CLI agent sessions)

In a second terminal — only needed for long-lived Claude-Code / Codex agent
sessions; the web app and onboarding work without it:

```bash
cd server && pnpm install && pnpm start    # agent server → http://localhost:4201
```

---

## 2. First run in the browser

Open **<http://localhost:4200>**. On a fresh install you are taken straight into
the **onboarding wizard** (`/oss-onboarding`):

1. **welcome** → 2. **full access** (macOS permissions, guided) →
3. **system check** (detects what's installed, offers safe one-click fixes) →
4. **install** (consented, streamed install of any missing engines) →
5. **engine** / 6. **connect** (Claude Code + Codex via terminal login or pasted
   key; Ollama optional) → 7. **purpose** → 8. **workspace** → 9. **github**
   (optional) → 10. **finalize** (boots services, verifies ports).

### Logging in

Pick **“Solo self-host”** on the login page and paste the access code. It was:

- printed by `setup.sh` at the end, and
- stored in `.env.local` — retrieve it any time with:

  ```bash
  grep LAZYOS_ACCESS_CODE .env.local
  ```

(With e-mail configured via `RESEND_API_KEY`, use the magic-link flow instead;
without it, the magic link is printed to the `pnpm dev` console.)

---

## 3. Verify it's healthy

```bash
pnpm verify:deploy        # build + boot smoke check
pnpm typecheck            # tsc --noEmit
pnpm test                 # full test suite (NODE_OPTIONS set automatically)
```

Quick manual checks while `pnpm dev` runs:

```bash
curl -s http://localhost:4200/api/system/health | head    # web app health
curl -s http://localhost:4201/health | head               # agent server (if started)
```

---

## 4. Test from your phone (optional)

To reach the dev instance from a phone on the same network or over a tunnel, set
`LAZYOS_PREVIEW_BASE_URL` and use the tunnel helper:

```bash
pnpm public            # opens a public tunnel and prints the URL
pnpm public:status     # show the active tunnel
pnpm public:stop       # tear it down
```

---

## Reset to a clean state

Everything lives in a local SQLite DB + `.env.local`. To start over:

```bash
# 1. remove the DB (default location when LAZYOS_DB_PATH is unset):
rm -f ~/.lazyos/lazyos.db*          # or the path you set in LAZYOS_DB_PATH
# 2. remove the local config (drops the auto-generated secrets):
rm -f .env.local
# 3. re-bootstrap from scratch:
bash scripts/setup.sh
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm: command not found` | `corepack enable && corepack prepare pnpm@latest --activate` |
| `Node.js is missing` / version warning | install Node ≥ 20 (Homebrew, nvm, or nodejs.org) |
| setup.sh stops on required vars | re-run it; it auto-generates them. If it still fails, set them in `.env.local` by hand |
| port 4200 busy | stop the other process, or set `PORT`/`LAZYOS_PORT` and adjust the URL |
| login code lost | `grep LAZYOS_ACCESS_CODE .env.local` |

More detail: [`docs/install/local.md`](docs/install/local.md) ·
[`docs/install/docker.md`](docs/install/docker.md) ·
[`docs/install/vps.md`](docs/install/vps.md).
