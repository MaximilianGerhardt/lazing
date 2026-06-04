# ADR 0007 — App-Store / MCP-Lifecycle Foundation

**Status:** accepted  
**Date:** 2026-05-25  
**Deciders:** maintainers (autonomous decision)

---

## Context

The platform needs a foundation for managing MCP-server plugins, connector manifests,
and skill-packs as installable, versioned, signed units — the "App Store". This requires:

1. A manifest format and validation layer.
2. Signature verification for publisher trust.
3. An install lifecycle (install/enable/disable/uninstall) with N8 audit trail.
4. A clear gating boundary between safe catalog operations (this phase) and
   unsafe activation operations (OAuth-connect, MCP-server spawn — R3-gated).

The foundation must be non-destructive: it registers manifests and install records.
It must not start processes, spawn MCP servers, or trigger OAuth flows.

---

## Decision

### Lifecycle: manifest → verify → install-record → [gated] activate

```
  ┌─────────────────────────────────────────────────────┐
  │           PHASE 1 — Foundation (this ADR)           │
  │                                                     │
  │  parse JSON ──► PII guard ──► Zod validate          │
  │       │                           │                 │
  │       └────────── upsertManifest ─┘                 │
  │                       │                             │
  │              sig verify (N6)                        │
  │                       │                             │
  │         app_manifests row + N10 hash                │
  │                       │                             │
  │            installApp(scope, actor)                 │
  │                       │                             │
  │         app_installs record (status=pending)        │
  │         app_install_audit row (N8)                  │
  │                                                     │
  └─────────────────────────────────────────────────────┘
                          │
              PHASE2_APP_ACTIVATE boundary (R3-gated)
                          │
  ┌─────────────────────────────────────────────────────┐
  │     PHASE 2 — Activate (NOT in this foundation)     │
  │                                                     │
  │  Read manifest.mcpServerCommand                     │
  │  Verify credential scopes available in Vault        │
  │  Spawn MCP server process (child_process / systemd) │
  │  Write app_installs.status = 'installed'            │
  │  Begin MCP tool enumeration (enumerateMcpTools)     │
  │  OAuth-connect if kind='connector' + oauth authKind │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

The `PHASE2_APP_ACTIVATE` boundary is marked explicitly in `lib/appstore/registry.ts`
with inline comments at every point where Phase 2 logic would attach.

### Schema: three tables

**`app_manifests`** (one row per app):
- `app_id` UNIQUE — machine-readable reverse-DNS identifier
- `kind` — 'mcp-server' | 'connector' | 'skill-pack'
- `manifest_json` TEXT — full declarative manifest (N1: never truncated)
- `signature` / `signature_status` — sig verification result (see §Signature)
- `source` — 'builtin' | 'local' | 'registry'
- `content_hash` — N10 sha256 over canonical JSON

**`app_installs`** (one row per app+scope):
- FK → `app_manifests.app_id` (ON DELETE CASCADE)
- `scope_kind` + `scope_id` — scope envelope (N9)
- `status` — 'installed' | 'disabled' | 'pending'
- `content_hash` — N10

**`app_install_audit`** (append-only N8 trace):
- All install/enable/disable/uninstall/verify actions
- `success` + `reason` — why did this action occur?
- `content_hash` — N10

### app_manifests vs. connector_catalog — no duplication

`app_manifests` and `connector_catalog` serve different purposes:

| Table | Purpose | Global? |
|-------|---------|---------|
| `connector_catalog` | Public API contract registry (endpoints, schemas, auth kind) | Platform-global, no scope |
| `app_manifests` | Versioned, signed manifest + lifecycle state per app | Platform-global (manifests), scope-per-install |

A kind='connector' or kind='mcp-server' manifest MAY mirror its declared
capabilities into `connector_catalog` after install — but only when
`mirrorToConnectorCatalog=true` is passed to `upsertManifest()`. This is opt-in
and best-effort. The two tables remain independent; `connector_catalog` has its
own PII guard and audit trail.

### Signature verification (N6 deterministic)

**Scheme:** Ed25519 over canonicalJSON(manifest)
- `canonicalJSON` = JCS RFC 8785 (same serializer used throughout N10 hash chain)
- The signed payload is the UTF-8 bytes of `canonicalJSON(manifest)` directly
  (Ed25519 applies its own internal hash per RFC 8032 — no external pre-hash).
- Signature: BASE64URL-encoded
- Verification (SIG-2, actual code in `lib/appstore/signature.ts`):
  ```js
  import { verify } from 'node:crypto';
  // algorithm = null: Ed25519 uses its built-in hash, no external algorithm.
  verify(null, Buffer.from(canonical, 'utf8'), pubkeyPem, Buffer.from(sig, 'base64url'))
  ```

**Status semantics (deterministic, no network I/O):**

| Condition | Status |
|-----------|--------|
| No signature field | `unsigned` |
| Signature + no pubkey | `unverified` |
| Signature + pubkey → verify=true | `valid` |
| Signature + pubkey → verify=false or error | `invalid` |

Trust-anchor management (which publisher keys are trusted) is R3-gated.
In this foundation, callers supply an explicit pubkey. The 'unverified' status
is the safe default for apps submitted from a local filesystem without a key.

**Why Ed25519 (no external pre-hash)?**
- Ed25519 is standardized (RFC 8032), well-supported in Node ≥ 12 via the
  one-shot `crypto.verify(null, data, key, sig)` / `crypto.sign(null, data, key)` API.
- No new crypto invented — uses `node:crypto` built-ins only.
- SIG-2 correction: an earlier draft of this ADR documented
  `createVerify('sha256').verify(...)`. That is WRONG for Ed25519 keys —
  `createVerify('sha256')` raises "Unsupported crypto operation" for Ed25519
  in Node ≥ 16, because Ed25519 does not accept an external hash algorithm
  separate from the curve operation. The correct API is the one-shot
  `verify(null, ...)` / `sign(null, ...)` with `algorithm=null`. The code
  has always used the correct API; only the ADR example was wrong and is now
  fixed.

### SIG-1: known Phase-2 gap (unverified ≠ valid install-gate)

In this foundation, `installApp()` HARD-BLOCKS only `signatureStatus==='invalid'`
when `initialStatus='installed'` (throws `APP_SIGNATURE_INVALID`). It does NOT
block `'unsigned'` or `'unverified'` manifests from reaching an 'installed'
record — a caller may deliberately install an unsigned local app.

**SIG-1 gap:** there is currently no policy layer that REQUIRES
`signatureStatus==='valid'` for `source='registry'` apps before activation.
Treating `'unverified'` as good-enough for activation is a Phase-2 (R3) policy
decision. The recommended Phase-2 gate:

```
if (install.initialStatus === 'installed' &&
    manifest.source === 'registry' &&
    manifest.signatureStatus !== 'valid') {
  throw new Error('[APP_SIGNATURE_REQUIRED] registry apps must be signed+valid');
}
```

This is intentionally NOT enforced in the foundation so that local/builtin
unsigned apps remain installable during development. It is recorded here so the
Phase-2 activator does not forget to add the registry-signature gate.

### Security posture

1. **PII Guard (structural):** `assertNonSensitiveManifest()` runs FIRST in
   `upsertManifest()`. Forbidden keys include all credential, scope-envelope,
   and identity fields. Throws `APP_STORE_PII_GUARD` before any DB access.
   Same pattern as `connector_catalog::assertNonSensitiveProfile()`.
   - **PII-1 (value scan):** `requestedCredentialScopes[]` VALUES are checked
     against the allowlist regex `^[a-z][a-z0-9._:-]{0,127}$`. The colon is
     allowed for the structured `server:tool:scope` form, but `=` is forbidden —
     a value like `api_key=sk-...` would smuggle credential material through a
     scope string and is rejected.
   - **PII-2 (heuristic arg scan):** `mcpServerArgs[]` VALUES are heuristically
     scanned for embedded secrets — secret-flags with inline values
     (`--token=...`, `--api-key=...`) and well-known token prefixes
     (`sk-`, `ghp_`/`gho_`/`ghs_`, `xoxb-`/`xoxp-`, JWT `eyJ...`). Placeholder
     references (`${SECRET}`, `{{token}}`, `$VAR`) are NOT flagged. Secrets must
     be passed via env-var references, never inline.

2. **Schema-string guard (ME-1):** `mcpTools[*].inputSchemaJson` must be a
   serialized string, never a raw object (mirrors connector catalog ME-1 rule).

3. **K1 compliance:** App installs that declare MCP tools in their manifest
   do NOT bypass K1. The K1 deny-list (`lib/security/k1-deny-patterns.ts`) is
   enforced at the MCP tool routing layer (tool-registry-filter.ts), not at
   the manifest layer. A manifest may declare a RAG tool name, but the runtime
   will still deny it via K1 at call time.

4. **AUTH-1 (no internal authz — caller-gated):** The registry lifecycle
   functions (`installApp`/`enableApp`/`disableApp`/`uninstallApp`) perform NO
   authorization or membership checks themselves — same posture as the vault.ts
   callers. The **Route-Layer MUST verify** that `actor` has membership in
   `scopeId` before calling, via `lib/security/membership.ts::hasRealWorkspaceMembership`
   (workspace scope) or the equivalent org-membership check (org scope). Every
   `@precondition` JSDoc documents this. For defense in depth, each function
   accepts an optional `assertAccess(actor, scopeKind, scopeId)` callback that,
   when provided, runs BEFORE any DB write — if it throws, no write and no
   success-audit row is produced. This lets the Route-Layer inject the real gate
   at the lowest layer. The HTTP surface (Phase 2) is NOT permitted to call these
   functions without a gate.

6. **Credential scopes declarative only:** `requestedCredentialScopes` in the
   manifest is a declaration for user disclosure. It does NOT grant any
   credential access. Actual resolution requires the Vault D2-policy
   (`lib/credentials/vault.ts`) with explicit actor authorization.

7. **No auto-activate:** Installing an app never automatically starts a process
   or triggers OAuth. The initial `status='pending'` requires an explicit
   `enableApp()` call to reach `status='installed'`. Phase 2 activation is
   a separate R3-gated step.

8. **Invalid signature install-block (R3-1/SIG-1):** `installApp()` throws
   `APP_SIGNATURE_INVALID` when `initialStatus='installed'` and the manifest's
   `signatureStatus='invalid'`. The stronger registry-signature gate
   (`source='registry'` ⇒ require `signatureStatus='valid'`) is a Phase-2
   policy decision documented in §SIG-1 above.

9. **N8 observable audit (N8-1):** `writeInstallAudit` is best-effort (a failed
   audit write does not abort the lifecycle operation), but a failure is logged
   via `console.error('[APP_STORE_AUDIT_WRITE_FAILED]', …)` so audit loss is
   observable rather than silent (N8: trace is evidence, not telemetry).

### Connector catalog integration (opt-in)

When `mirrorToConnectorCatalog=true` is passed to `upsertManifest()`:
- For `kind='mcp-server'`: declared `mcpTools` are mirrored as capabilities
  with `source='mcp-discovery'`.
- For `kind='connector'`: declared `capabilities` are mirrored with
  `source='manual'`.
- Mirror is best-effort: failures are swallowed and do not abort the manifest
  upsert. The connector_catalog PII guard runs on all mirrored data.
- The connector_catalog `provider` key is set to `manifest.appId`.

---

## Consequences

**Positive:**
- Non-destructive foundation: all existing tables, schemas, and lifecycle
  code are unchanged. New tables only.
- Clear R3-gated PHASE2_APP_ACTIVATE boundary prevents accidental process
  spawning or credential exposure.
- N8 append-only audit trail captures the complete install lifecycle.
- N10 content_hash on all rows enables tamper detection.
- PII Hard-Guard mirrors the established pattern from connector_catalog.
- Optional connector_catalog mirror keeps the two systems loosely coupled.

**Negative / accepted:**
- `app_manifests.manifest_json` stores the full manifest as TEXT. Large
  manifests (many declared tools) will consume more DB space than a normalized
  schema. Acceptable for V1: manifests are rarely written and read infrequently.
- Signature scheme requires key distribution infrastructure (Phase 2).
  'unverified' is the safe default until trust anchors are managed.
- `mirrorToConnectorCatalog` uses a dynamic `require()` to avoid circular
  imports between lib/appstore and lib/connectors. Acceptable: this code path
  is opt-in and never on the hot path.

**PHASE2_APP_ACTIVATE gate — R3 triggers:**
1. Operator unlocks R3 (configuration flag or DB toggle — not defined in Phase 1).
2. Activator reads `app_installs` with `status='installed'`.
3. For `kind='mcp-server'`: reads `manifest.mcpServerCommand`, spawns child
   process, begins MCP tool enumeration via `enumerateMcpTools()`.
4. For `kind='connector'`: triggers OAuth flow via `lib/credentials/vault.ts`
   if `authKind='oauth'`, else prompts operator for api_key via UI.
5. Both paths write `app_installs.status = 'installed'` + audit row on success.
6. K1 deny-list re-evaluated against newly enumerated MCP tools.

**Sources:**
- N6, N8, N10: CLAUDE.md §"Operating constraints (N1–N11)"
- K1: `lib/security/k1-deny-patterns.ts`, `lib-v1/mcp/tool-registry-filter.ts`
- PII pattern: `lib/connectors/catalog.ts::assertNonSensitiveProfile()`
- Credential vault: `lib/credentials/vault.ts` (D2-policy)
- MCP tool enumeration: `lib-v1/mcp/tool-registry.ts::enumerateMcpTools()`
- Implementation: `lib/appstore/manifest.ts`, `lib/appstore/signature.ts`,
  `lib/appstore/registry.ts`, `db/schema/app_store.ts`,
  `db/migrations/0108_app_manifests.sql`
- Tests: `lib/appstore/__tests__/app-store.test.ts`
