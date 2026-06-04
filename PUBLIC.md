# Making laz.ing publicly reachable (share links)

> **TL;DR:** Run `pnpm public`. It auto-installs cloudflared if missing, opens a
> public HTTPS tunnel to your local app, and keeps every share link
> (`/c/<token>`) pointed at the live URL — no restart, no account. For a **stable**
> URL without owning a domain, use `pnpm public:stable` (Tailscale, free account).

For someone to open a `/c/<token>` share-chat, your app (running locally on
`:4200`) must be reachable publicly over HTTPS. There are three ways — from "runs
instantly, no account" to "your own branded domain". You don't have to edit any
config by hand: the tunnel manager writes the current public URL automatically to
where the app reads it for share links (`data/public-url`, **live**, no restart).

---

## 1. Instant, no account — `pnpm public`  ← default

```bash
pnpm public
```

- Installs `cloudflared` automatically if missing (Homebrew or the official binary).
- Opens a **Cloudflare Quick Tunnel** → a `https://…trycloudflare.com` URL.
- Writes the URL live to `.env.local` **and** `data/public-url` → all new share
  links use it **immediately** (no app restart).
- Runs as a supervisor (auto-restart). Stop with `Ctrl-C` or `pnpm public:stop`.

**Trade-off:** the URL is **ephemeral** — on a tunnel restart it **rotates**, and
already-sent links die (the manager warns loudly). Perfect for demos / tests /
short-lived chats. For permanent links → option 2 or 3.

---

## 2. Stable URL, free, no own domain — `pnpm public:stable`  ← recommended for real use

```bash
# one-time: install Tailscale + log in (free account)
#   macOS:  brew install tailscale && tailscale up
#   Linux:  curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
# in the Tailscale admin: enable HTTPS + Funnel for your tailnet (one-time)

pnpm public:stable
```

- Enables **Tailscale Funnel** → a **stable** `https://<machine>.<tailnet>.ts.net` URL.
- Stays the **same** across app and machine restarts → sent links stay valid.
- Runs in the background via `tailscaled` (no supervisor/launchd needed).
- Stop: `tailscale funnel --bg 4200 off`.

The best compromise between "stable" and "minimal effort" — no domain purchase,
no DNS.

---

## 3. Your own domain (branded URL, secured at the edge) — `pnpm public:domain chat.your-domain.tld`

```bash
cloudflared tunnel login            # one-time, selects your Cloudflare zone
pnpm public:domain chat.your-domain.tld
# follow the printed instructions (create / route dns / run)
```

- A **named tunnel** on your domain. Extra security: the ingress is
  **path-scoped at the edge** — only `/c/` + `/api/subchats/external/` + static
  assets reach the origin; **your operator UI is not publicly reachable at all**
  (everything else → 404).
- Requires a domain in a Cloudflare account.

---

## Keeping it running (across login/reboot)

For option 1 or 3 (option 2 persists on its own):

```bash
./scripts/public-tunnel-launchd.sh                    # Quick Tunnel as a launchd agent
./scripts/public-tunnel-launchd.sh --named --hostname chat.your-domain.tld
```

## Status / Stop

```bash
pnpm public:status     # shows current URL + public reachability (/api/health)
pnpm public:stop       # stops the Quick/Named tunnel
```

---

## Security before going live (important)

The external endpoints are hardened (token auth, rate limit 20/120 per minute,
upload-type hardening 25 MB, media boundary, SSE connection cap). Still:

- **Quick Tunnel (option 1)** exposes the whole app URL — protected only by login
  + rate limit. For real public use prefer **option 3** (edge path-scoped) or
  option 2 and share only `/c/` links.
- Before the first public share, do a quick smoke test against the public URL:
  ```bash
  curl -sI https://<your-url>/api/health     # expected reachable
  curl -s  https://<your-url>/api/subchats/external/INVALID -o /dev/null -w '%{http_code}\n'  # 404
  ```
