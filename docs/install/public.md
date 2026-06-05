# Public Install — laz.ing on the open internet (no tunnel service)

> The code identifier prefix `lazyos` (`LAZYOS_*` env, systemd unit names `lazyos-*`)
> is a legacy schema kept unchanged for compatibility behind the laz.ing brand.

This guide puts laz.ing on a public domain over **HTTPS** using a **reverse proxy**
on a host you control — no Tailscale, no Cloudflare Tunnel, no third-party in the
data path. The app keeps binding to `127.0.0.1`; only the proxy listens on the
public ports 80/443.

Prerequisites: a working laz.ing install (see [`NEW-MACHINE.md`](../../NEW-MACHINE.md)
for first run, or [`docs/install/vps.md`](./vps.md) for a long-running VPS setup),
a server with a **public IP**, and a domain you can point at it.

Why HTTPS is not optional: laz.ing session cookies are `HttpOnly + Secure + SameSite=Lax`.
A `Secure` cookie is never sent over plain HTTP, so over `http://` you can never stay
logged in. You **must** terminate TLS.

---

## 1. Recommended: reverse proxy + your own domain + automatic HTTPS

### 1a. Point DNS at your server

Create one DNS **A record** (and an `AAAA` record if you have IPv6):

```
chat.example.com   A      203.0.113.10      # your server's public IPv4
chat.example.com   AAAA   2001:db8::10      # optional, if you have IPv6
```

Wait for it to resolve (`dig +short chat.example.com`) before requesting a
certificate — Let's Encrypt validates over the live domain.

### 1b. Caddy (lead choice — automatic Let's Encrypt, one-line config)

Caddy fetches and renews TLS certificates for you with zero extra config.

**Install (Debian/Ubuntu):**

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

(macOS: `brew install caddy`. Other systems: <https://caddyserver.com/docs/install>.)

**`/etc/caddy/Caddyfile`** — this is the whole thing:

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:4200
}
```

That single block tells Caddy to listen on 80/443, get + auto-renew a Let's Encrypt
certificate for `chat.example.com`, redirect HTTP→HTTPS, and proxy to laz.ing on
loopback. Caddy also sets the standard `X-Forwarded-Proto`/`X-Forwarded-For`
headers the app relies on to know the request arrived over HTTPS.

If you also want the agent server (`:4201`) public on its own subdomain, add:

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:4201
}
```

> You usually do **not** need to expose `:4201`. The web app talks to it on
> loopback. Only expose it if an external client must reach the agent server.

**Run it:**

```bash
sudo systemctl enable --now caddy        # start + run on boot
sudo systemctl reload caddy              # after editing the Caddyfile
journalctl -u caddy -f                   # watch logs / cert issuance
```

Browse `https://chat.example.com/login`. The lock icon should be green and the
login page should load.

laz.ing itself is unchanged: it still binds `127.0.0.1:4200`. Verify it is **not**
listening on a public interface:

```bash
ss -tlnp | grep -E ':4200|:4201'    # both should show 127.0.0.1, never 0.0.0.0
```

### 1c. nginx (if you already run nginx)

Get a cert first (`sudo apt install certbot python3-certbot-nginx`,
then `sudo certbot --nginx -d chat.example.com` to auto-fill TLS), then:

```nginx
server {
    listen 80;
    server_name chat.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4200;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / streaming chat needs buffering off + long read timeout
        proxy_buffering off;
        proxy_read_timeout 3600s;

        # WebSocket / upgrade passthrough
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

`certbot` installs a renewal timer automatically (`systemctl list-timers | grep certbot`).

### 1d. Traefik (if you already run Traefik)

Static config — enable the ACME (Let's Encrypt) resolver:

```yaml
# traefik.yml
entryPoints:
  web:
    address: ":80"
    http:
      redirections:
        entryPoint: { to: websecure, scheme: https }
  websecure:
    address: ":443"

certificatesResolvers:
  le:
    acme:
      email: you@example.com
      storage: /etc/traefik/acme.json
      httpChallenge:
        entryPoint: web
```

Dynamic config — route the domain to the loopback service:

```yaml
# dynamic.yml
http:
  routers:
    lazing:
      rule: "Host(`chat.example.com`)"
      entryPoints: [websecure]
      service: lazing
      tls: { certResolver: le }
  services:
    lazing:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:4200"
```

---

## 2. Required env when public

Once a public hostname is in front of the app, set these in `.env.local` (the same
file `scripts/setup.sh` created — see [`NEW-MACHINE.md`](../../NEW-MACHINE.md)) and
restart laz.ing:

```bash
# The canonical public origin. Used for cookies, redirects, magic-links,
# share links, and the default allowed CORS origin.
LAZYOS_PUBLIC_URL=https://chat.example.com

# Extra allowed browser origins (space/comma separated), if any beyond the
# public URL above. Leave unset if you only serve one domain.
LAZYOS_CORS_ORIGINS=https://chat.example.com
```

Then confirm your secrets are strong. `scripts/setup.sh` auto-generates these on
first run; never ship placeholder or example values to a public host:

```bash
grep -E 'LAZYOS_AUTH_SECRET|LAZYOS_ACCESS_CODE|LAZYOS_CREDENTIAL_KEY' .env.local
```

- `LAZYOS_AUTH_SECRET` — signs sessions. Auto-generated, high-entropy. If you ever
  rotate it, all existing sessions are invalidated (everyone re-logs-in).
- `LAZYOS_ACCESS_CODE` — the master access / admin-fallback code (see §4).
- `LAZYOS_CREDENTIAL_KEY` — encrypts the PII / credentials vault at rest.

Reminder: cookies are `Secure`, so they only travel over `https://`. If
`LAZYOS_PUBLIC_URL` is `https://…` but you reach the box over plain HTTP somehow,
login will silently fail to persist. HTTPS end-to-end is mandatory.

---

## 3. Hardening checklist

- [ ] **Firewall: only 80 and 443 open.** Everything else closed inbound.
  ```bash
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
  sudo ufw allow 22/tcp          # keep your SSH port
  sudo ufw allow 80,443/tcp
  sudo ufw enable
  ```
- [ ] **Keep `:4200` and `:4201` bound to localhost. Never expose them directly.**
  The reverse proxy is the only public listener. Confirm with
  `ss -tlnp | grep -E ':4200|:4201'` — both must show `127.0.0.1`, not `0.0.0.0`.
- [ ] **Codeless owner-setup is loopback-only — by design.** The "Get started"
  first-run owner bootstrap (no code) is only offered to requests coming from the
  machine itself (loopback, not proxied/tunneled). A request arriving through the
  reverse proxy carries forwarding headers and is treated as remote, so it **must**
  present the access code. You cannot accidentally claim ownership from the internet.
- [ ] **Enable 2FA / TOTP** on the owner account (and any admin) after first login.
- [ ] **Keep the PII / credentials vault on** (`LAZYOS_CREDENTIAL_KEY` set) — see
  [`docs/encryption-setup.md`](../encryption-setup.md).
- [ ] **Back up the SQLite database** (and `.env.local`, which holds your keys).
  ```bash
  sqlite3 data/lazyos.db ".backup '/var/backups/lazyos-$(date +%F).db'"
  ```
  Back up `data/` as a whole if you also want uploads/state. Store backups
  off-box.
- [ ] **Keep it updated.** Pull and restart regularly:
  ```bash
  cd ~/lazing && git pull && ./start      # or: re-run scripts/setup.sh, then restart your service
  ```
  If you run laz.ing under systemd (see [`docs/install/vps.md`](./vps.md)),
  `git pull` then `sudo systemctl restart lazyos-web lazyos-agent`.

---

## 4. Admin fallback — you can always get back in

laz.ing keeps a master login independent of email delivery:

- **Access code login.** Go to `/login` and use the `LAZYOS_ACCESS_CODE` value from
  `.env.local`. This works even if email (magic-link) is unconfigured or down, and
  is the admin fallback for a locked-out owner.
- **Host-side recovery.** Because you control the machine, you can always recover
  locally: read or rotate `LAZYOS_ACCESS_CODE` in `.env.local` and restart, or run
  the first-run bootstrap from the box itself (loopback) where no code is required.
  Inspect or repair accounts directly with `sqlite3 data/lazyos.db`.

Other auth available: email magic-link, email/password login, and org/workspace
roles. The access code is the break-glass path.

---

## 5. Alternative — only if you have no public IP or can't port-forward

If you are behind CGNAT / a router you don't control and genuinely cannot open
80/443, use a **named Cloudflare Tunnel** instead of a reverse proxy. This gives a
stable branded URL with no inbound ports — full steps are in
[`docs/install/vps.md`](./vps.md) §5 and [`PUBLIC.md`](../../PUBLIC.md) option 3.

> **Trade-off, stated plainly:** a tunnel re-introduces a **third-party dependency**
> in your request path (Cloudflare terminates TLS and forwards to your origin) —
> exactly the dependency the reverse-proxy approach above avoids. Prefer the reverse
> proxy whenever you have a public IP and can forward ports. Use the tunnel only
> when you cannot.

---

## 6. Is it secure? — threat-model note

What you get with the reverse-proxy setup above:

- **HTTPS end-to-end**, TLS terminated on a host you own (no third party in the
  path). Automatic certificate renewal.
- **No plaintext auth.** Sessions are `HttpOnly + Secure + SameSite=Lax`; nothing
  authenticating travels over plain HTTP. The vault is encrypted at rest.
- **Loopback-only codeless setup** means the internet can never claim ownership;
  remote access always requires the access code.

What changes the moment you go public: the app is now reachable by anyone, so it is
**exposed to internet-wide scanning and credential attacks**. Your security now
rests on operational discipline, not obscurity:

- Strong, auto-generated secrets — never reuse, never commit, never use examples.
- **2FA on every privileged account.**
- Patch promptly (`git pull` + restart); subscribe to release notes.
- Firewall down to 80/443 only; keep app ports on loopback.
- Back up the SQLite DB and `.env.local` off-box.

See also: [`SECURITY.md`](../../SECURITY.md), [`docs/encryption-setup.md`](../encryption-setup.md),
[`NEW-MACHINE.md`](../../NEW-MACHINE.md), [`README.md`](../../README.md).
