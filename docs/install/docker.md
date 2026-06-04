# Docker install — laz.ing

Three commands to a running laz.ing on any machine with Docker.

> Prerequisite: Docker (Engine 24+ recommended) + Docker Compose plugin v2.

## Quickstart

```bash
git clone https://github.com/MaximilianGerhardt/lazing.git
cd lazyos
cp .env.example .env.local
# fill the minimum (see README): LAZYOS_AUTH_SECRET, LAZYOS_ACCESS_CODE,
# LAZYOS_CREDENTIAL_KEY, LAZYOS_OWNER_EMAIL, LAZYOS_OWNER_DISPLAY_NAME
docker compose up --build
```

After ~3 min: `http://localhost:4200/login`.

## Generate env values

```bash
# add to .env.local:
node -e 'console.log("LAZYOS_AUTH_SECRET=" + require("crypto").randomBytes(32).toString("hex"))'
node -e 'console.log("LAZYOS_CREDENTIAL_KEY=" + require("crypto").randomBytes(32).toString("hex"))'
node -e 'console.log("LAZYOS_ACCESS_CODE=" + require("crypto").randomBytes(12).toString("hex"))'
```

## What happens on the first `docker compose up`?

1. **Build** (~2-3 min, one-time)
   - Multi-stage: pnpm install + `next build` in the builder stage.
   - The runtime copies only `.next`, `node_modules`, `db/`, `lib/`, `server/`, `scripts/`.
2. **Container start**
   - `docker-entry.sh` runs migrations + the setup script (idempotent).
   - The web server starts on port 4200.
3. **Healthcheck** on `/api/health` — when 200 → the container is `healthy`.

## Data persistence

The SQLite volume `lazyos_data` is mounted at `/data` in the container and
survives `docker compose down`. To wipe everything:

```bash
docker compose down -v   # -v removes the volume!
```

Backup:

```bash
docker run --rm -v lazyos_data:/data -v $(pwd):/backup busybox \
  cp /data/lazyos.db /backup/lazyos-$(date +%F).db
```

## Updates

```bash
git pull
docker compose up --build -d   # rebuild + recreate
```

Migrations run idempotently on start.

## Agent server (port 4201)

**Not started** in the default image, because the agent CLI is not bundled.
Three options:

### A) Extend the image with the agent CLI

```dockerfile
# Dockerfile.with-claude
FROM lazyos:local
RUN npm i -g @anthropic-ai/claude-code
```

```bash
docker build -f Dockerfile.with-claude -t lazyos:with-claude .
# .env.local: LAZYOS_CHAT_KEY=<your-bearer-secret>
docker compose up
```

### B) Mount your CLI config as a volume

```yaml
# docker-compose.override.yml
services:
  lazyos:
    image: lazyos:with-claude  # see A
    volumes:
      - ~/.claude:/root/.claude:rw
```

### C) Solo self-host without spawns

Leave the agent server out. You can use all UI features (chat routing, tickets,
workstreams as a data structure, inbox, push), but no automatic code spawning.

## Cloudflare tunnel container (optional)

`docker-compose.yml` has a commented-out `tunnel` service. To enable it:

```bash
# 1. Token from dash.cloudflare.com -> Zero Trust -> Tunnels -> Create
# 2. In .env.local:
echo "CLOUDFLARE_TUNNEL_TOKEN=<your-token>" >> .env.local
# 3. Uncomment the `tunnel:` block in docker-compose.yml
docker compose up -d
```

Then laz.ing is publicly reachable without exposing any ports.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error: better-sqlite3 not found` | Native bindings for the wrong architecture | Rebuild the image: `docker compose build --no-cache` |
| Healthcheck fails after 60 s | Setup script takes too long | Check logs: `docker compose logs lazyos`. Migration may be blocked. |
| `LAZYOS_OWNER_EMAIL not set — skip setup` | Setup-skip path — no default founder | Use `/login` operator bootstrap with `LAZYOS_ACCESS_CODE`. |
| Port 4200 already in use | Another process | Change `ports: ["4201:4200"]` or stop the other process. |

## Hardening for production

- TLS via a Cloudflare tunnel or a reverse proxy (nginx, Caddy).
- Do not copy `.env.local` into the image (it is in `.dockerignore`).
- Set up a volume-backup cron.
- Run `docker compose pull` regularly for base-image updates.

## Build size

| Stage | Image size |
|---|---|
| builder | ~700 MB |
| runtime (final) | ~280 MB |

Multi-stage saves ~60% compared to single-stage.
