/**
 * lazyOS Agent-Server — SQLite client.
 *
 * Shares the same schema as the Next.js side (db/client.ts + db/schema/*) but
 * opens its own handle because:
 *   - The Next.js client is a singleton scoped to that package's imports.
 *   - The agent-server runs as a separate process (`lazyos-agent.service`).
 *   - better-sqlite3 supports multiple readers/writers on WAL — which we
 *     enable below — so both processes can hit the same file.
 *
 * DB path is driven by LAZYOS_DB_PATH (default `~/.lazyos/lazyos.db`).
 * The Next.js side still defaults to `./data/lazyos-events.db` locally and
 * `/tmp/lazyos-events.db` on Vercel; in Sprint 2 we consolidate to the
 * home-dir path, which means the Next.js process must also set
 * LAZYOS_DB_PATH to the same file for the single-source-of-truth invariant
 * to hold. That env-wiring happens in the Next.js systemd unit.
 *
 * Schema: we re-apply `db/migrations/0001_initial.sql` at startup. It is
 * idempotent (IF NOT EXISTS everywhere) so running it twice from two
 * processes is safe.
 */

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH =
  process.env.LAZYOS_DB_PATH ?? path.join(os.homedir(), '.lazyos', 'lazyos.db');

// The migrations live in the Next.js package next to this one. We locate
// them relative to this file so both dev (from the repo's `server/` dir)
// and systemd (same WorkingDirectory) resolve the same absolute path.
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MIGRATION_PATHS = [
  path.join(PROJECT_ROOT, 'db', 'migrations', '0001_initial.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0002_workspaces.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0003_heartbeats.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0004_routines.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0005_work_products.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0006_claude_sessions.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0007_workflow_state.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0008_organizations.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0009_workstreams.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0011_skills.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0013_workspace_notes.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0014_workspace_credentials.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0015_workspace_brand.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0017_client_visibility.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0018_streaming_snapshots.sql'),
  // 0093: chat_ledger (N8 trace). The agent server must be able to create the
  // table ITSELF, instead of relying on the Next migration in the shared DB file
  // (Critic-MAJOR 2026-05-24). `CREATE TABLE IF NOT EXISTS` → idempotent.
  path.join(PROJECT_ROOT, 'db', 'migrations', '0093_chat_ledger.sql'),
  // 0096: org_github_credentials (Slice A 2026-05-24). The agent server needs
  // the table when it resolves org GitHub tokens for API calls (Slice C).
  path.join(PROJECT_ROOT, 'db', 'migrations', '0096_org_github_credentials.sql'),
  // 0097: lexical RAG FTS5 (N7, 2026-05-24). Agent-server retrieval paths
  // benefit from the FTS table; triggers keep it in sync.
  path.join(PROJECT_ROOT, 'db', 'migrations', '0097_rag_fts.sql'),
  // 0099: SAR-2 SOP framework (2026-05-24). sops + sop_steps + binding columns
  // on routines. action_kind DEFAULT 'shell' — the agent-server side needs the
  // tables when it resolves SOPs for the plan-dispatch flow (SAR-3 wave 2).
  path.join(PROJECT_ROOT, 'db', 'migrations', '0098_permission.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0099_sops.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0103_connector_onboarding_sop.sql'),
  // ACL (2026-05-24): generic credential vault + connector catalog +
  // workspace.credential_isolation. The agent-server side needs the tables
  // as soon as the plan-dispatch/connector flow resolves credentials/profiles.
  path.join(PROJECT_ROOT, 'db', 'migrations', '0100_api_credentials.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0101_connector_catalog.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0102_workspace_credential_isolation.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0104_connector_catalog_audit.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0105_connector_calls.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0106_org_github_token_use_audit.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0107_plan_step_allowed_tools.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0108_app_manifests.sql'),
  // N8-Fix (2026-05-25): workstream_evidence/decisions waren nie registriert.
  path.join(PROJECT_ROOT, 'db', 'migrations', '0069_workstream_evidence.sql'),
  path.join(PROJECT_ROOT, 'db', 'migrations', '0071_workstream_decisions.sql'),
  // 0109: permission owner-default → 'ask' (Fail-Open-Fix, defense-in-depth).
  path.join(PROJECT_ROOT, 'db', 'migrations', '0109_permission_owner_default_ask.sql'),
  // 0110: subplan orchestration metadata (depends_on + group_id) for parallel executor.
  path.join(PROJECT_ROOT, 'db', 'migrations', '0110_plan_step_deps_group.sql'),
  // 0127 (2026-06-03): claude_sessions rotation bookkeeping (token_estimate,
  // task_key, rotation_count/_at/_reason, prev_session_id) for the autonomous
  // degrade→handoff→rotate loop. ALTER ADD COLUMN, idempotent.
  path.join(PROJECT_ROOT, 'db', 'migrations', '0127_session_rotation.sql'),
];

function execMigrationTolerant(db: Database.Database, sql: string): void {
  // TD-2 fix 2026-04-26: better-sqlite3 `exec()` handles multi-statement +
  // multi-line SQL natively. Regex-splitting on `;\s*$/m` breaks statements
  // like `CREATE UNIQUE INDEX ... WHERE entity_type='chat_message' AND ...`
  // whose WHERE clause spans lines. Try whole-file first; only fall back to
  // per-statement on duplicate-column (idempotent ALTER TABLE ADD COLUMN).
  try {
    db.exec(sql);
    return;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(msg)) throw err;
  }
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.match(/^\s*--/));
  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate column name/i.test(msg)) continue;
      throw err;
    }
  }
}

let cachedDb: Database.Database | null = null;

export function getAgentDb(): Database.Database {
  if (cachedDb) return cachedDb;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const raw = new Database(DB_PATH);
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');

  // FK-during-migration (2026-05-24, mirrors db/client.ts): FK enforcement
  // off during the trusted schema migration, then back on. Prevents
  // a DDL-triggered FK revalidation from failing on pre-existing orphan rows
  // (e.g. workspaces→organizations). Restore to ON for runtime.
  raw.pragma('foreign_keys = OFF');

  // Idempotent schema bootstrap — safe even if Next.js already created tables.
  for (const migrationPath of MIGRATION_PATHS) {
    try {
      const sql = readFileSync(migrationPath, 'utf8');
      execMigrationTolerant(raw, sql);
    } catch (err) {
      // Migration file is nice-to-have from here; in production the Next.js side
      // will have run it. We log but don't crash.
      // eslint-disable-next-line no-console
      console.warn(
        `[lazyos-agent] migration not applied (${migrationPath}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  // Restore FK enforcement for all runtime queries.
  raw.pragma('foreign_keys = ON');

  cachedDb = raw;
  return raw;
}

export function getDbPath(): string {
  return DB_PATH;
}

// ---------------------------------------------------------------------------
// ULID — inline copy (see lib/ulid.ts for rationale).
// The Next.js side imports `lib/ulid.ts` but this sub-package deliberately
// avoids reaching across the package boundary so `tsc --noEmit` stays local.
// ---------------------------------------------------------------------------

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom = new Uint8Array(RANDOM_LEN);

function encodeTime(now: number): string {
  let mod = now;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const r = mod % ENCODING_LEN;
    out = (ENCODING[r] ?? '0') + out;
    mod = (mod - r) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[(bytes[i] ?? 0) % ENCODING_LEN] ?? '0';
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      const next = ((lastRandom[i] ?? 0) + 1) & 0xff;
      lastRandom[i] = next;
      if (next !== 0) break;
    }
  } else {
    lastTime = now;
    const buf = new Uint8Array(RANDOM_LEN);
    globalThis.crypto.getRandomValues(buf);
    lastRandom = buf;
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}
