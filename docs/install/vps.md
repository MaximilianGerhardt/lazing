# VPS Install — laz.ing on Ubuntu

> The code identifier prefix `lazyos` (`LAZYOS_*` env, systemd unit names `lazyos-*`, tunnel name `lazyos`) is a legacy schema kept unchanged for compatibility behind the laz.ing brand.

Production-style deploy: long-running Next.js + agent-server + watchdog, exposed via a Cloudflare Tunnel (no inbound ports needed). Tested on Ubuntu 22.04 / 24.04.

> Time-budget: ~30 minutes from blank VM to first login.

## 0. Prerequisites

A reasonable VPS (Hetzner CPX21 / Hostinger KVM-2 / DigitalOcean 2 GB / similar — **2 vCPU, 4 GB RAM is the floor**).

```bash
# pick your provider, ssh in:
ssh root@<vps>

# minimal hardening (optional but recommended)
adduser dev
usermod -aG sudo dev
rsync --archive --chown=dev:dev ~/.ssh ${HOME}/
```

Then continue as `dev` user.

## 1. System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git tmux curl ca-certificates
```

## 2. Node + pnpm

```bash
# nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# pnpm
corepack enable
corepack prepare pnpm@latest --activate
```

## 3. claude-code CLI (optional, for real spawns)

```bash
npm i -g @anthropic-ai/claude-code
claude login          # opens an URL — paste the token in your local browser
```

## 4. Clone + setup

```bash
cd ${HOME}
git clone https://github.com/<your-fork>/lazyos.git
cd lazyos
cp .env.example .env.local
nano .env.local   # fill: LAZYOS_AUTH_SECRET, LAZYOS_ACCESS_CODE,
                  #       LAZYOS_CREDENTIAL_KEY, LAZYOS_OWNER_EMAIL,
                  #       optional Resend, VAPID, etc.
bash scripts/setup.sh
```

## 5. Cloudflare Tunnel (recommended)

Cloudflare Tunnel = no open ports, no certificate dance, public URL out-of-the-box.

```bash
# install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

# auth + create tunnel
cloudflared login                       # opens an URL
cloudflared tunnel create lazyos
cloudflared tunnel route dns lazyos lazyos.your-domain.com
```

`~/.cloudflared/config.yml`:
```yaml
tunnel: lazyos
credentials-file: ${HOME}/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: lazyos.your-domain.com
    service: http://localhost:4200
  - service: http_status:404
```

If you want both web (4200) **and** agent-server (4201) public:
```yaml
ingress:
  - hostname: lazyos.your-domain.com
    service: http://localhost:4200
  - hostname: agent.your-domain.com
    service: http://localhost:4201
  - service: http_status:404
```

Test:
```bash
cloudflared tunnel run lazyos
```
Browse `https://lazyos.your-domain.com/login` → login page should load.

## 6. systemd units

Three units: web, agent-server, tunnel. Optional fourth: watchdog.

`/etc/systemd/system/lazyos-web.service`:
```ini
[Unit]
Description=laz.ing web (Next.js)
After=network.target

[Service]
Type=simple
User=dev
WorkingDirectory=/opt/lazyos
Environment="NODE_ENV=production"
EnvironmentFile=/opt/lazyos/.env.local
ExecStartPre=/usr/local/bin/pnpm build
ExecStart=/usr/local/bin/pnpm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/lazyos-agent.service`:
```ini
[Unit]
Description=laz.ing agent-server
After=network.target

[Service]
Type=simple
User=dev
WorkingDirectory=/opt/lazyos
Environment="NODE_ENV=production"
EnvironmentFile=/opt/lazyos/.env.local
ExecStart=/usr/local/bin/pnpm tsx server/agent-server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/lazyos-tunnel.service`:
```ini
[Unit]
Description=Cloudflare Tunnel — laz.ing
After=network.target

[Service]
Type=simple
User=dev
ExecStart=/usr/local/bin/cloudflared tunnel run lazyos
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable + start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lazyos-web lazyos-agent lazyos-tunnel
sudo systemctl status lazyos-web
```

## 7. Watchdog (optional)

```bash
sudo cp systemd/lazyos-watchdog.service /etc/systemd/system/
sudo cp systemd/lazyos-watchdog.timer /etc/systemd/system/
sudo systemctl enable --now lazyos-watchdog.timer
```

Watchdog runs every 60 s, restarts agent-server if `/api/health` ≠ 200.

## 8. First login

`https://lazyos.your-domain.com/login` → magic-link or Solo-Self-Host. Same as local.

## 9. Updates

```bash
cd /opt/lazyos
git pull
pnpm install
pnpm tsx scripts/lazyos-setup.ts   # idempotent — runs new migrations
sudo systemctl restart lazyos-web lazyos-agent
```

## Hardening checklist

- [ ] `LAZYOS_AUTH_SECRET` ≥ 32 hex
- [ ] `LAZYOS_ACCESS_CODE` ≥ 16 chars, not in any wordlist
- [ ] `LAZYOS_CREDENTIAL_KEY` 64 hex (= 32 bytes)
- [ ] `RESEND_API_KEY` set + sending domain verified in Resend dashboard
- [ ] firewall: only allow ssh (no public 4200/4201) — Cloudflare Tunnel handles ingress
- [ ] regular DB-backups: `cp ~/.lazyos/lazyos.db /backup/lazyos-$(date +%F).db`
- [ ] watchdog active

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| 502 Bad Gateway | web service dead | `sudo systemctl restart lazyos-web` |
| /api/chat/stream times out | agent-server dead or claude-code not logged in | `sudo systemctl status lazyos-agent`; `claude login` |
| Magic-link mails not arriving | sending domain not verified in Resend | open Resend dashboard, verify DNS |
| Tunnel connects then drops | `cloudflared` outdated | `sudo apt install --only-upgrade cloudflared` |
| sqlite locked | concurrent writes | wait, laz.ing auto-retries — if persistent, check disk space |
