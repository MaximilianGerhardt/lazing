# Security Policy

> **laz.ing.** Code identifiers such as `LAZYOS_*` env vars and `lazyos-cli` are a
> legacy schema and remain unchanged behind the laz.ing brand.

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security findings.** We ask for
responsible disclosure.

<!-- TODO(owner): set a real security contact address before publishing. -->
→ E-mail: **contact@laz.ing**
→ Subject: `[laz.ing] <short description>`

An optional PGP key for sensitive reports is available on request.

### What to include

- Affected component (path / URL / endpoint)
- laz.ing version or commit hash (`git rev-parse HEAD`)
- Reproduction (as compact as possible)
- Impact assessment (auth bypass? data leak? privilege escalation? RCE?)
- Suggested fix (optional, but welcome)

### What to expect

| Phase | SLA |
|---|---|
| Acknowledgement of receipt | < 48 hours |
| Initial triage + CVSS score | < 5 business days |
| Fix plan + ETA | < 10 business days (critical: ASAP) |
| Public disclosure | after fix release, coordinated |

We credit reporters in the CHANGELOG (if they wish).

## Scope

### In-Scope

- **Auth & sessions** (`app/api/auth/*`, `lib/security/session.ts`, `lib/security/crypto.ts`)
- **Magic-link flow** (`app/api/auth/magic/issue`, `verify`)
- **Operator bootstrap & master login** (`/api/auth/bootstrap`, `/api/auth/master-login`)
- **Per-user plan credentials** (`/api/users/me/claude-creds`, AES-256-GCM at rest)
- **Org / workspace permissions** (`lib/security/permissions.ts`)
- **Edge middleware rate limiting** (`middleware.ts`)
- **Push subscription endpoints** (privacy leak via push payload)
- **Agent server bridge** (port 4201, bearer token)

### Out-of-Scope

- Self-XSS via skill definitions you injected yourself (you are root)
- DoS against your own single-tenant stack (you host it yourself)
- Findings that require physical access to the DB file (defense-in-depth via `LAZYOS_CREDENTIAL_KEY`)
- Third parties (Resend, Cloudflare, Vercel) — please report to the respective vendor

## Hardening checklist before a production deploy

- `LAZYOS_AUTH_SECRET` >= 32 random bytes (hex)
- `LAZYOS_ACCESS_CODE` >= 16 chars, not a dictionary word
- `LAZYOS_CREDENTIAL_KEY` 64 hex chars, never committed
- Enforce HTTPS (Cloudflare tunnel or your own certificate)
- `Set-Cookie: HttpOnly; Secure; SameSite=Lax` (default in `lib/security/session.ts`)
- Rate-limit all unauthenticated POST endpoints (mind the `middleware.ts` allow-list)
- Audit logging active (`writeAudit({...})` in every state-mutating handler)
- Encrypted-at-rest for **all** credentials (`lib/security/credentials.ts.encryptCredential`)
- Same-origin check on state-mutating POSTs that carry a secret

## Known threat-model assumptions

- laz.ing is **not** built for multi-tenant SaaS hosting. Single-tenant self-host
  is the default model. If you run it multi-tenant, you need DB isolation (RLS or
  similar) — that is not built in today.
- `LAZYOS_ACCESS_CODE` is an **operator master key**. Whoever has it can master-log-in
  as the first founder. Treat it like a root password.
- The agent CLI has, by design, Bash/Read/Write access to the host. Anyone who can
  act as a member of a workspace can execute code in that workspace.

## Hall of Fame

_(Reporters are listed here with their consent.)_
