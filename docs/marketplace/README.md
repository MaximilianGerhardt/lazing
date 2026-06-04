# Marketplace submissions — laz.ing

We want to list laz.ing on one-click-install marketplaces. This doc describes
**how** + **what** is needed for each provider. The actual submission is an
owner action (branding approval, a Stripe listing fee if required, legal vetting
of the license / DPA).

## Audience per provider

| Provider | Audience | Difficulty | Listing fee | ETA |
|---|---|---|---|---|
| **Hostinger** | Indie builders, solo devs | medium | optional | 2–4 wk |
| **DigitalOcean** | Pro devs, small teams | high (audit + tests) | none | 4–8 wk |
| **Cloudron** | Self-host enthusiasts | medium (app manifest) | optional | 1–2 wk |
| **Coolify** | Self-host + Heroku refugees | low (compose-only) | none | immediate |
| **Railway** | Quick-deploy, hackathon crowd | low (template) | none | immediate |

**Recommended order:**
1. **Coolify** + **Railway** — low barrier to entry, fast listing.
2. **Cloudron** — larger self-host community, a good vertical audience.
3. **Hostinger** — a marketing push.
4. **DigitalOcean** — last, because the audit is involved.

## What we already have

| Asset | Status | Path |
|---|---|---|
| Docker image | ✅ | `Dockerfile`, `docker-compose.yml` |
| ENV docs | ✅ | `.env.example` |
| Setup wizard | ✅ | `pnpm tsx scripts/lazyos-setup.ts` (idempotent) |
| Healthcheck | ✅ | `GET /api/health` |
| Multi-stage build | ✅ | builder + runtime |
| README with USPs | ✅ | `README.md` |
| 3-sentence pitch | ✅ | below in this file |
| 5 screenshots | ❌ | TODO, see `docs/marketplace/screenshots/` |
| Logo (SVG) | 🟡 | `public/icons/icon-512.png` present, SVG missing |
| DPA stub | 🟡 | `docs/legal/dpa-stub.md` (TODO) |
| License | ✅ | AGPL-3.0-or-later (`LICENSE`) |
| SaaS terms | n/a | Self-host = the user is their own data controller |

## 3-sentence pitch

> **laz.ing is a sniper for AI agents.** Multi-agent swarms plan in parallel —
> you correct the shot mid-flight until everything fits. Not yet another VS Code
> plugin: an OS for AI workflows with multi-user, multi-workspace and
> bring-your-own-plan pricing.

Alternative for small businesses / agencies:

> **One browser tab instead of five editor windows.** laz.ing manages all your
> clients, projects and AI-assisted tasks in one place. Org containers for
> business reality, sniper correction for mid-flight intervention, self-host for
> full data sovereignty.

## Screenshot list (TODO)

5 screenshots for each submission. Resolution at least 1920×1080:

1. **Login page** with magic link + the solo-self-host tab
2. **Org detail** with a segmented workspace list (own projects / clients)
3. **Workstream with a sniper pause** — live countdown, inject card visible
4. **Workspace landing** — the marketing USP
5. **/how index** — the how-to overview, for trust

Format: PNG, optimized with `pngquant` or `oxipng` for <500 kB per asset. Place
them under `docs/marketplace/screenshots/<id>.png`.

## GDPR + DPA

Self-host ≠ SaaS. laz.ing does not process data on our behalf — the operator
(= the user hosting laz.ing) is the sole data controller.

→ No DPA with the laz.ing maintainers required.
→ DPAs with sub-processors (Anthropic, Resend, Cloudflare) must be concluded by
  the operator themselves.

Stub doc: `docs/legal/dpa-stub.md` (TODO).

## Submission packages

One folder per provider:

- `docs/marketplace/hostinger-submission/`
- `docs/marketplace/digitalocean/`
- `docs/marketplace/cloudron/`
- `docs/marketplace/coolify/`
- `docs/marketplace/railway/`

Each folder has its own README with provider-specific requirements + space for
submission forms / API tokens.
