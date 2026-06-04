# ADR 0006 — Connector catalog N2 demarcation: platform-global is N2-conformant

**Status:** accepted  
**Date:** 2026-05-24  
**Deciders:** maintainers (autonomous decision)

---

## Context

N2 (operating constraint, `CLAUDE.md` §"N1–N11"):
> "No global RAG fallback ever. Scope envelope per chunk and per query; audit row
> in same transaction (fail-closed)."

N2 forbids: semantic search across workspace boundaries, a global RAG fallback,
and storing content without a `ManifestCoord` scope envelope.

`connector_catalog` was introduced as a platform-global table without a
`workspace_id` and without an `org_id`. At first glance this could look like an
N2 violation — "global, no scope envelope".

This ADR documents why that is **not** an N2 violation, and which structural
measures enforce the N2 demarcation permanently.

---

## Decision

**`connector_catalog` is N2-conformant — for four structurally-enforced reasons.**

### Reason 1: No RAG fallback, no semantic retrieval

N2 forbids a **global RAG fallback** — i.e. semantic search that reaches into
content from different workspaces without an explicit bridge-approval transaction.

`connector_catalog` is not a RAG system. It has:
- **no embedding vector**, no `blob(embedding)` in the table.
- **no semantic search** — the only lookup path is `WHERE provider = ?`
  (primary-key equivalent via a UNIQUE constraint on `provider`).
- **no rag_chunks rows** from the connector catalog — it is physically separate
  from `rag_chunks` and shares no write pipeline.

N2 protects `rag_chunks` from scope-less access. `connector_catalog` is a
different table with a different concept: a structured reference work, not a
retrieval index.

### Reason 2: Public, non-personal data only

The scope envelope from N2 + GDPR Art. 30 is required for **personal data,
workspace content, proprietary documents**.

`connector_catalog` stores only:
- Publicly documented endpoint URLs
- JSON schemas from official API documentation
- Auth kind (not the auth value)
- Rate limits and API versions from vendor docs
- Links to public documentation

This is not GDPR-relevant data. No chat content, no file content, no ticket
content, no user data. A `ManifestCoord` scope envelope on such data would not
only be unnecessary — it would falsely imply that a data-protection boundary
crossing is happening here.

### Reason 3: PII hard guard (structural enforcement, not advisory)

To permanently rule out a future ingestion path accidentally writing sensitive
data into `connector_catalog`, there is:

**`lib/connectors/catalog.ts::assertNonSensitiveProfile()`**

- Called **FIRST** in `upsertConnectorProfile()`, before any DB write.
- Throws `Error{ code: 'CONNECTOR_PII_GUARD' }` if any of the following keys
  appears in the input (top level or in `capabilities[]` objects):

  ```
  workspace_id | workspaceId | org_id | orgId | user_id | userId | email |
  token | secret | api_key | apiKey | credential | credentials | password |
  private_key | privateKey | access_token | accessToken | refresh_token |
  refreshToken | client_secret | clientSecret
  ```

- This guard is **not optional and not bypassable** — it is the first code path
  on every write.
- Consequence: the ingestion path **structurally** cannot write sensitive data,
  regardless of what a caller passes. Test (b) in `catalog.test.ts` verifies this
  for workspace_id, token, email, org_id, user_id and capability injection.

### Reason 4: No `workspace_id` schema field (design lock)

The SQL table `connector_catalog` has **no `workspace_id` field and no `org_id`
field**. This is not an oversight but a deliberate design decision:

- A SQL `INSERT` with a `workspace_id` value → error `table connector_catalog has
  no column named workspace_id`.
- The Drizzle schema `db/schema/connectors.ts` likewise has no such column.
- That means: even without the application-layer guard, it is physically
  impossible to write a workspace-scoped row into this table.

Schema + application guard are redundant, independent enforcement layers.

---

## N2 clarification: what N2 protects vs. what it does not regulate

| Concept | N2-relevant? | Reasoning |
|---------|-------------|-----------|
| `rag_chunks`: semantic search over workspace content | Yes — N2 enforced | Workspace content, scope envelope required |
| `connector_catalog`: per-name lookup of public API docs | **No** | No RAG, no PII, no user content |
| `rag_retrieval_audit`: bridge GDPR row | Yes — N2 enforced | Audit in the same transaction |
| `connector_capabilities`: JSON schemas from vendor docs | **No** | Public documentation, non-personal |

N2 protects the **RAG retrieval system** from scope-less access to user content.
It is not a general rule against every platform-global table — otherwise `skills`,
`sops` (with `workspace_id IS NULL` rows) and other global template tables would
also be N2 violations, which is not the intent of the constraint.

---

## Credentials separation

Real credentials (API keys, OAuth tokens, PATs) are **never** stored in
`connector_catalog`. They go into `api_credentials`:

- `api_credentials`: scope = org|workspace, `encrypted_secret` (AES-256-GCM),
  `resolveApiCredential()` with the isolation/inherit policy.
- `connector_catalog`: `auth_kind` = TYPE information ('api_key' | 'oauth' | ...),
  never a value.

This separation is also structurally enforced by the PII hard guard (an `api_key`
key as a value field in the input → the guard throws).

---

## Consequences

**Positive:**
- A platform-global connector catalog is safely deployable without an N2 violation.
- The PII hard guard makes it structurally impossible to inject sensitive data.
- A clearly documented demarcation from `rag_chunks` (different table, different
  pipeline, different retrieval model).
- Connector knowledge, learned once, is usable everywhere (across workspaces) —
  that is the core use case.

**Negative / accepted:**
- Platform-global write access requires operator trust — anyone with DB access
  can write connector profiles. That is acceptable for a non-sensitive reference
  catalog.
- The hard guard checks key names, not value semantics — an attacker could hide
  sensitive data in an allowed key like `description`. That is an accepted
  residual risk; the catalog is not designed for sensitive payloads, and the
  schema leaves no room for structured sensitive fields.

**Open items:**
- Connector-onboarding SOP + coverage validator (N6). The SOP will populate
  `upsertConnectorProfile` via the researcher → scribe → validator path. The PII
  hard guard applies in this path too.
- A real API call with a resolved credential (gated) — the gate chain is separate
  and has no impact on connector_catalog.

**Sources:**
- N2: `CLAUDE.md` §"Operating constraints (N1–N11)" N2.
- Implementation: `lib/connectors/catalog.ts`, `db/schema/connectors.ts`,
  `db/migrations/0101_connector_catalog.sql`.
- Tests: `lib/connectors/__tests__/catalog.test.ts` (test-b: PII-guard verification).
