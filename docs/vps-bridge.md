# VPS-Bridge (Read-Proxy)

> **Status:** Sprint 2 — read-only proxy.
> Writes (POST/PATCH/DELETE) still hit the **local** SQLite on Vercel. That path is tracked for Sprint 3.

## Why this exists

Vercel serverless functions re-create `/tmp/lazyos.db` on every cold-start. The authoritative lazyOS state — workspaces, tickets, heartbeats, routines, run history — lives in `${HOME}/.lazyos/lazyos.db` on the VPS, where the heartbeat, agent backend, and cron workers all have persistent access.

To keep the Vercel frontend truthful, read-side API routes on Vercel proxy through to the VPS Next.js instance (port 4200, exposed via Cloudflare tunnel).

```
Browser ──► Vercel /api/workspaces ──► VPS (tunnel) /api/workspaces ──► VPS SQLite
```

## Components

| File | Purpose |
| ---- | ------- |
| `lib/vps-bridge/types.ts` | Error classes + shared interfaces. |
| `lib/vps-bridge/proxy.ts` | `proxyToVps` / `tryProxyToVps` — fetch helper with 10s timeout, bearer auth, typed JSON parse. |
| `lib/vps-bridge/route-helpers.ts` | `bridgeOrLocal` — prefer VPS, degrade to local, stamp response headers. |
| `middleware.ts` | Added bridge-bearer gate: `Authorization: Bearer $LAZYOS_VPS_BRIDGE_SECRET` bypasses the cookie-session check. |

## Route coverage

Read endpoints proxied in Sprint 2:

- `GET /api/workspaces`
- `GET /api/tickets`
- `GET /api/tickets/[id]`
- `GET /api/tickets/[id]/timeline`
- `GET /api/heartbeat/status`
- `GET /api/routines`
- `GET /api/routines/[id]/runs`

Writes (POST/PATCH/DELETE) are deliberately **not** proxied yet — see Sprint 3 scope.

## Response headers

| Header | Meaning |
| ------ | ------- |
| `X-LazyOS-Source: vps` | Response came from the VPS (bridge healthy). |
| `X-LazyOS-Source: local` | Bridge not configured — local DB served the response. This is the dev/local default. |
| `X-LazyOS-Source: local_fallback` | Bridge was configured but failed; local DB served a degraded response. |
| `X-LazyOS-Degraded: bridge_<reason>` | Only set on fallback. Reasons: `not_configured`, `unavailable`, `invalid_json`, `http_<status>`. |

The client can render a "VPS not reachable" banner whenever `X-LazyOS-Degraded` is present.

## Configuration

### On Vercel (production env)

```
LAZYOS_WEB_URL=https://<tunnel-host>.trycloudflare.com
LAZYOS_VPS_BRIDGE_SECRET=<32-byte hex, same as VPS>
```

Generate the shared secret (one-time):

```bash
openssl rand -hex 32
```

### On the VPS (`/opt/lazyos/.env.local`)

```
LAZYOS_VPS_BRIDGE_SECRET=<same value as Vercel>
```

Restart the VPS Next.js (`systemctl restart lazyos` or equivalent) so the middleware picks up the new env.

### Locally (`.env.local`)

Leave both vars **unset** to use the local DB directly. Setting only `LAZYOS_WEB_URL` without the secret will be treated as "not configured" (both values required).

## Security

- The bridge secret is Node-side only — never prefixed with `NEXT_PUBLIC_`.
- Middleware uses a constant-time compare against the configured secret.
- The proxy deliberately does **not** forward the inbound `Authorization` or `Cookie` headers to the VPS — the Vercel edge already validated the user session; the VPS call is a trusted service-to-service hop.
- Short secrets (< 16 chars) are rejected by the middleware as misconfiguration.

## Operational gotchas

1. **Tunnel flakiness**: Cloudflare free-tier tunnels can drop. The proxy has a 10s timeout and a `BridgeUnavailableError` that always degrades gracefully — the UI will show the fallback path, not a 500.
2. **Secret rotation**: change the env on both sides. Mismatched secrets return 401 from the VPS → the Vercel route degrades and emits `X-LazyOS-Degraded: bridge_http_401`.
3. **Write drift**: because writes still hit Vercel's ephemeral DB, a ticket created on Vercel will only be visible on that specific serverless instance until Sprint 3 lands. The UI should flag "created locally, awaiting sync" once the write-proxy ships.

## Local smoke test

```bash
# On VPS, generate a secret and set it both places
S=$(openssl rand -hex 32)
echo "LAZYOS_VPS_BRIDGE_SECRET=$S" >> /opt/lazyos/.env.local

# Test the VPS side accepts the bearer:
curl -s -H "Authorization: Bearer $S" \
  https://<tunnel-host>.trycloudflare.com/api/workspaces | jq

# In another shell, run the Vercel build pointed at the same tunnel:
LAZYOS_WEB_URL=https://<tunnel-host>.trycloudflare.com \
LAZYOS_VPS_BRIDGE_SECRET=$S \
  pnpm dev

# Then hit the local proxy — should return the VPS's 10 workspaces, not empty:
curl -si http://127.0.0.1:3000/api/workspaces | head -20
```

Expected: the response body contains all 10 VPS workspaces, and `X-LazyOS-Source: vps` is present.
