# DigitalOcean Marketplace — laz.ing submission

## Provider specifics

DigitalOcean Marketplace = **App Platform** + **1-Click apps for Droplets**.

| Form | What | Submission path |
|---|---|---|
| **1-Click Droplet** | Image-based (a snapshot of a Droplet with laz.ing pre-installed) | https://docs.digitalocean.com/products/marketplace/details/listing-1-click-app/ |
| **App Platform** | Container-based (Dockerfile) | https://docs.digitalocean.com/products/marketplace/details/listing-app-platform/ |

**Recommendation for laz.ing: App Platform** — we already have a working
Dockerfile + docker-compose.yml. A 1-Click Droplet would be more effort
(snapshot maintenance, OS updates).

## Submission requirements

1. **Public GitHub repo** (✅).
2. **Build spec** in `.do/app.yaml`:
   ```yaml
   name: lazyos
   services:
     - name: lazyos-web
       dockerfile_path: Dockerfile
       http_port: 4200
       envs:
         - key: LAZYOS_AUTH_SECRET
           type: SECRET
         # ...
       health_check:
         http_path: /api/health
   databases:
     - name: lazyos-db
       engine: PG
       # WRONG — we use sqlite. App Platform supports volumes only via
       # managed DBs OR Spaces (S3-compatible).
   ```
3. **A Spaces volume** for SQLite persistence (or a PostgreSQL migration —
   sqlite3 is ephemeral in the container).
   → **Blocker:** we would have to port laz.ing to PostgreSQL. Not in scope today.
4. **Setup wizard** = our `lazyos-setup.ts` runs on container boot.
5. **Audit + tests** by DigitalOcean — 4–8 weeks of approval.

## Current blocker for DigitalOcean App Platform

App Platform persists **no** local filesystem between deploys. The SQLite file is
gone on every re-deploy. Options:

A) **Build managed PostgreSQL** into laz.ing (its own effort).
B) **A Spaces mount** for the SQLite file (not atomic, race conditions possible).
C) **Do not list on App Platform — 1-Click Droplet only.**

For now: **option C** — DigitalOcean only as a 1-Click Droplet, not App Platform.

## 1-Click Droplet submission

1. Spin up a Droplet on Ubuntu 22.04.
2. Install laz.ing following the `docs/install/vps.md` guide.
3. Create a snapshot.
4. Fill in the submission form: https://marketplace.digitalocean.com/apps/submit
   - Public GitHub repo
   - Snapshot ID
   - Setup guide (3 commands for the first login)
   - Logo, screenshots, tagline
5. Wait 4–8 weeks.

## Open tasks

- [ ] Automate the snapshot build (a Packer script for CI)
- [ ] Decision: PostgreSQL migration or Droplet-only
- [ ] Create a DigitalOcean vendor account
- [ ] Logo + 5 screenshots, as for Hostinger
