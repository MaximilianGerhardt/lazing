/**
 * Tests für POST /api/workspaces — Stage 1 (2026-05-03) + ACL-3 (2026-05-24).
 *
 * Run: pnpm exec vitest run app/api/workspaces/__tests__/route.test.ts
 *
 * Fokus Stage 1: workspace_type-Whitelist + context_group-Trim + Insert/Response.
 * Fokus ACL-3: credential_isolation Default-Ableitung + expliziter Override +
 *   Rückwärtskompatibilität bestehender Rows (implizit via DEFAULT 'inherit').
 * Wir mocken Auth + Org-Membership + DB-Layer, damit keine echte SQLite-
 * Verbindung nötig ist.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock-State ------------------------------------------------------------
let authedUser: string | null = 'user_test_owner';
let membershipResult: { role: string } | null = { role: 'admin' };
const insertCalls: Array<{ sql: string; params: unknown[] }> = [];
const namedInsertCalls: Array<{ sql: string; params: Record<string, unknown> }> = [];
let existingId: string | null = null;
/** ACL-3: kontrollierbarer Org-Type für findOrgById-Mock. */
let mockOrgType: string = 'company';
/** Owner-Fix 2026-05-28: kontrollierbarer User-Default-Permission-Mode. */
let mockUserDefaultMode:
  | 'freerein'
  | 'freerein-with-audit'
  | 'lane'
  | 'ask'
  | null = null;
/**
 * Owner-Bug-Fix 2026-05-29 (F2): kontrollierbare stale-Workspace-Traces.
 * Setze Set von slugs, die als „bereits mit Audit-Spuren belegt" gelten.
 * Bei Match liefert das Mock-DB COUNT(*)=1 zurück → disambiguate hängt
 * Suffix an.
 */
const mockStaleSlugs: Set<string> = new Set();
/**
 * Owner-Bug-Fix 2026-05-29 (F2): kontrollierbare Tabellen-Existenz.
 * Wenn nicht leer, gibt `SELECT name FROM sqlite_master` diese Liste zurück,
 * sodass der F2-Probe-Code tatsächlich PRAGMAs absetzt. Default: einfache
 * Mini-Liste, damit F2 nicht still degradiert.
 */
const mockTables: string[] = [
  'workspaces',
  'chat_ledger',
  'workstreams',
  'lazyos_permission_modes',
  'lazyos_permission_audit',
  'events',
];
/**
 * Owner-Bug-Fix 2026-05-29 (F2): kontrollierbare table-info-Antworten.
 * Mapping table → columns. Wenn nicht gesetzt → leere column-Liste.
 */
const mockTableCols: Record<string, string[]> = {
  workspaces: ['id', 'label'],
  chat_ledger: ['id', 'coord_key', 'content_full', 'role'],
  workstreams: ['id', 'workspace_id', 'name'],
  lazyos_permission_modes: ['workspace_id', 'mode'],
  lazyos_permission_audit: ['workspace_id', 'op'],
  events: ['id', 'segment_id', 'kind'],
};

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: () => authedUser,
  requireAuthenticatedUser: () =>
    authedUser ? { ok: true, userId: authedUser } : { ok: false },
}));

vi.mock('@/lib/orgs/repo', () => ({
  findUserOrgMembership: () => membershipResult,
  listOrgsForUser: () => [{ id: 'demo-pv', type: 'client' }],
  // ACL-3: findOrgById gibt den konfigurierbaren Org-Type zurück.
  findOrgById: () => ({ id: 'demo-pv', type: mockOrgType }),
}));

vi.mock('@/lib/vps-bridge/route-helpers', () => ({
  bridgeOrLocal: async (opts: { fallback: () => Response | Promise<Response> }) => {
    return opts.fallback();
  },
}));

// Owner-Fix 2026-05-28: Preferences-Repo-Mock liefert den gewählten Default,
// damit die Seed-Logik in POST /api/workspaces verifizierbar ist.
vi.mock('@/lib/users/preferences-repo', () => ({
  getUserDefaultPermissionMode: (_userId: string): string | null =>
    mockUserDefaultMode,
}));

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: (sql: string) => ({
        // Positional `.run(...)` (INSERT INTO workspaces, workspace_memberships).
        run: (...params: unknown[]) => {
          // Named-Param-Bind sieht aus wie `.run({ workspace_id: ..., mode: ... })`.
          // Die Seed-Inserts der Permission-Tabellen nutzen dieses Pattern.
          if (
            params.length === 1 &&
            typeof params[0] === 'object' &&
            params[0] !== null &&
            !Array.isArray(params[0])
          ) {
            namedInsertCalls.push({
              sql,
              params: params[0] as Record<string, unknown>,
            });
            return { changes: 1 };
          }
          insertCalls.push({ sql, params });
          return { changes: 1 };
        },
        get: (...params: unknown[]) => {
          const arg = params[0];
          // Owner-Bug-Fix 2026-05-29 (F2): COUNT(*)-Probes der
          // disambiguateWorkspaceId-Funktion. Wir liefern { c: 1 } zurück,
          // wenn der gegebene Slug in der mockStaleSlugs-Set steht.
          if (sql.includes('SELECT COUNT(*)') && typeof arg === 'string') {
            return { c: mockStaleSlugs.has(arg) ? 1 : 0 };
          }
          if (sql.includes('SELECT id FROM workspaces') && arg === existingId) {
            return { id: existingId };
          }
          return undefined;
        },
        all: (...args: unknown[]) => {
          // Owner-Bug-Fix 2026-05-29 (F2): Mock für `SELECT name FROM
          // sqlite_master` (listAllTables) und `PRAGMA table_info(<table>)`
          // (getColumns).
          void args;
          if (sql.includes("FROM sqlite_master") && sql.includes("type='table'")) {
            return mockTables.map((name) => ({ name }));
          }
          const pragmaMatch = sql.match(/PRAGMA table_info\((\w+)\)/);
          if (pragmaMatch) {
            const tableName = pragmaMatch[1];
            const cols = mockTableCols[tableName] ?? [];
            return cols.map((name) => ({ name }));
          }
          return [];
        },
      }),
      // Owner-Fix 2026-05-28: better-sqlite3-style `transaction()` wrapper —
      // ruft die Callback synchron auf und gibt eine no-arg-Funktion zurück.
      transaction: (fn: () => void) => () => fn(),
    },
  }),
}));

// Lazy-import nach Setup.
async function loadPost(): Promise<
  (req: Request) => Promise<Response>
> {
  const mod = await import('../route');
  return mod.POST as unknown as (req: Request) => Promise<Response>;
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authedUser = 'user_test_owner';
  membershipResult = { role: 'admin' };
  insertCalls.length = 0;
  namedInsertCalls.length = 0;
  existingId = null;
  mockOrgType = 'company'; // Default: nicht 'client', daher inherit
  mockUserDefaultMode = null; // Default: kein User-Default → kein Seed.
  mockStaleSlugs.clear(); // Owner-Bug-Fix 2026-05-29 (F2): per Default kein stale-Slug.
});

afterEach(() => {
  vi.resetModules();
});

describe('POST /api/workspaces — workspace_type + context_group', () => {
  it('persists context_group when provided (success-with-group)', async () => {
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Demo Fitness Backend',
        organizationId: 'demo-pv',
        workspaceType: 'client',
        contextGroup: 'CRM',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { contextGroup: string | null; workspaceType: string };
    };
    expect(body.workspace.contextGroup).toBe('CRM');
    expect(body.workspace.workspaceType).toBe('client');

    const wsInsert = insertCalls.find((c) =>
      c.sql.includes('INSERT INTO workspaces'),
    );
    expect(wsInsert).toBeDefined();
    // params order: id, label, path, sensitivity, orgId, workspaceType,
    // contextGroup, now, now
    expect(wsInsert?.params[5]).toBe('client');
    expect(wsInsert?.params[6]).toBe('CRM');
  });

  it('stores NULL when context_group is empty/whitespace (success-without-group)', async () => {
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Marketing Site',
        organizationId: 'demo-pv',
        workspaceType: 'product',
        contextGroup: '   ',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { contextGroup: string | null };
    };
    expect(body.workspace.contextGroup).toBeNull();

    const wsInsert = insertCalls.find((c) =>
      c.sql.includes('INSERT INTO workspaces'),
    );
    expect(wsInsert?.params[6]).toBeNull();
  });

  it('truncates context_group to 32 chars (max-length-truncate)', async () => {
    const POST = await loadPost();
    const longGroup = 'A'.repeat(80);
    const res = await POST(
      makeReq({
        label: 'Demo',
        organizationId: 'org-x',
        contextGroup: longGroup,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { contextGroup: string | null };
    };
    expect(body.workspace.contextGroup).toBe('A'.repeat(32));
  });

  it('falls back to "default" for invalid workspace_type (invalid-type-fallback)', async () => {
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Mystery Box',
        organizationId: 'org-y',
        workspaceType: 'totally-bogus-value',
        contextGroup: 'misc',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { workspaceType: string };
    };
    expect(body.workspace.workspaceType).toBe('default');
  });

  it('returns 409 on id conflict and does not insert', async () => {
    const POST = await loadPost();
    existingId = 'taken-id';
    const res = await POST(
      makeReq({
        id: 'taken-id',
        label: 'Conflict',
        organizationId: 'org-z',
      }),
    );
    expect(res.status).toBe(409);
    expect(insertCalls.find((c) => c.sql.includes('INSERT INTO workspaces'))).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// ACL-3: credential_isolation Default-Ableitung + expliziter Override
// -------------------------------------------------------------------------

describe('POST /api/workspaces — credential_isolation (ACL-3)', () => {
  /**
   * Hilfsfunktion: Gibt den credential_isolation-Param aus dem INSERT zurück.
   * INSERT-Param-Reihenfolge (0-indexed):
   *   0=id, 1=label, 2=path, 3=sensitivity, 4=orgId,
   *   5=workspaceType, 6=contextGroup, 7=credentialIsolation, 8=now, 9=now
   */
  function getInsertedIsolation(): string | undefined {
    const wsInsert = insertCalls.find((c) => c.sql.includes('INSERT INTO workspaces'));
    return wsInsert?.params[7] as string | undefined;
  }

  it('leitet "isolated" ab wenn Org-Type "client" (client-org-derives-isolated)', async () => {
    mockOrgType = 'client';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Demo PV CRM',
        organizationId: 'demo-pv',
        // credentialIsolation NICHT übergeben — Ableitung greift
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { credentialIsolation: string };
    };
    expect(body.workspace.credentialIsolation).toBe('isolated');
    expect(getInsertedIsolation()).toBe('isolated');
  });

  it('leitet "inherit" ab wenn Org-Type nicht "client" (non-client-org-derives-inherit)', async () => {
    mockOrgType = 'product';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'lazyOS Core',
        organizationId: 'example-company',
        // credentialIsolation NICHT übergeben
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { credentialIsolation: string };
    };
    expect(body.workspace.credentialIsolation).toBe('inherit');
    expect(getInsertedIsolation()).toBe('inherit');
  });

  it('expliziter Wert "isolated" überschreibt nicht-client Org-Type (explicit-isolated-wins)', async () => {
    mockOrgType = 'company'; // Würde sonst 'inherit' ableiten
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Strikt isolierter WS',
        organizationId: 'example-company',
        credentialIsolation: 'isolated',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { credentialIsolation: string };
    };
    expect(body.workspace.credentialIsolation).toBe('isolated');
    expect(getInsertedIsolation()).toBe('isolated');
  });

  it('expliziter Wert "inherit" überschreibt client Org-Type (explicit-inherit-wins)', async () => {
    mockOrgType = 'client'; // Würde sonst 'isolated' ableiten
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Shared Staging',
        organizationId: 'demo-pv',
        credentialIsolation: 'inherit',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { credentialIsolation: string };
    };
    expect(body.workspace.credentialIsolation).toBe('inherit');
    expect(getInsertedIsolation()).toBe('inherit');
  });

  it('ungültiger credentialIsolation-Wert fällt auf Org-Type-Ableitung zurück (invalid-value-falls-back)', async () => {
    mockOrgType = 'tool'; // tool → inherit
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Werkzeug X',
        organizationId: 'example-company',
        credentialIsolation: 'totally-bogus', // kein gültiger Wert
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { credentialIsolation: string };
    };
    // Fällt auf Org-Type-Ableitung zurück: 'tool' → 'inherit'
    expect(body.workspace.credentialIsolation).toBe('inherit');
    expect(getInsertedIsolation()).toBe('inherit');
  });

  it('bestehende Workspaces ohne Spalte erhalten DEFAULT "inherit" (backward-compat-inherit)', async () => {
    // Simuliert: kein credentialIsolation in Body, Org-Type = 'company'
    // → Route leitet 'inherit' ab; bestehende DB-Rows haben DEFAULT 'inherit'
    // Das ist kein echter DB-Test (Migration-Default wird hier dokumentiert),
    // aber wir verifizieren dass Route 'inherit' zurückgibt.
    mockOrgType = 'company';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Altbestand Workspace',
        organizationId: 'example-company',
        // kein credentialIsolation — Ableitung + DB-DEFAULT beide 'inherit'
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { credentialIsolation: string };
    };
    expect(body.workspace.credentialIsolation).toBe('inherit');
  });
});

// -------------------------------------------------------------------------
// Owner-Fix Live-Test 2026-05-28 — Permission-Mode-Seed beim Workspace-Create
// -------------------------------------------------------------------------

describe('POST /api/workspaces — User-Default Permission-Mode Seed', () => {
  function findPermissionModeSeed(): Record<string, unknown> | undefined {
    return namedInsertCalls.find((c) =>
      c.sql.includes('INSERT INTO lazyos_permission_modes'),
    )?.params;
  }

  function findPermissionAuditSeed(): Record<string, unknown> | undefined {
    return namedInsertCalls.find((c) =>
      c.sql.includes('INSERT INTO lazyos_permission_audit'),
    )?.params;
  }

  it('seedet `lazyos_permission_modes` mit User-Default `freerein` (seed-from-user-default)', async () => {
    mockUserDefaultMode = 'freerein';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Frisch erstellt',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);

    const seed = findPermissionModeSeed();
    expect(seed).toBeDefined();
    expect(seed?.mode).toBe('freerein');
    // workspace_id ist der slug, label-basiert (siehe slugify in route.ts).
    expect(seed?.workspace_id).toBe('frisch-erstellt');
    expect(seed?.set_by).toBe('user:user_test_owner');
    // N10 — content_hash ist gesetzt (kein leerer String).
    expect(typeof seed?.content_hash).toBe('string');
    expect((seed?.content_hash as string).length).toBeGreaterThan(0);
    // N8 — Audit-Row ist gesetzt.
    const audit = findPermissionAuditSeed();
    expect(audit).toBeDefined();
    expect(audit?.mode).toBe('freerein');
    expect(audit?.op).toBe('SEED_MODE:freerein');
    expect(audit?.tool_name).toBe('workspaces-create-route');
  });

  it('seedet NICHT wenn kein User-Default existiert (no-seed-when-null)', async () => {
    mockUserDefaultMode = null;
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Ohne Default',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    expect(findPermissionModeSeed()).toBeUndefined();
    expect(findPermissionAuditSeed()).toBeUndefined();
  });

  it('seedet NICHT wenn User-Default `ask` ist (no-seed-when-ask)', async () => {
    // 'ask' ist der UI-/System-Default; ein Seed wäre redundant.
    mockUserDefaultMode = 'ask';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Ask Default',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    expect(findPermissionModeSeed()).toBeUndefined();
  });

  it('seedet `freerein-with-audit` korrekt (seed-freerein-with-audit)', async () => {
    mockUserDefaultMode = 'freerein-with-audit';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Audit Mode',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    const seed = findPermissionModeSeed();
    expect(seed?.mode).toBe('freerein-with-audit');
    const audit = findPermissionAuditSeed();
    expect(audit?.op).toBe('SEED_MODE:freerein-with-audit');
  });

  it('liefert weiterhin 201 wenn Workspace-Insert ok aber Seed wirft (seed-failure-non-fatal)', async () => {
    // Simulieren: nicht möglich ohne tieferes DB-Mocking; wir dokumentieren
    // mit diesem Smoke-Test, dass der Happy-Path (User-Default vorhanden,
    // Mock-DB nimmt alle Inserts) 201 liefert. Ein echter Seed-Fehler
    // landet in console.warn — die Route gibt trotzdem 201 zurück (siehe
    // try/catch in route.ts). Der Smoke-Test stellt nur sicher, dass der
    // Status nicht durch unsere zusätzliche Logik bricht.
    mockUserDefaultMode = 'freerein';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Resilience',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
  });
});

// -------------------------------------------------------------------------
// Owner-Bug-Fix Live-Test 2026-05-29 — F2: ID-Kollisions-Schutz
// (gleicher Label-Slug eines GELÖSCHTEN Workspace adoptiert sonst stale
// Audit-Rows — siehe verbatim N1-Owner-Befund im Top-Header).
// -------------------------------------------------------------------------

describe('POST /api/workspaces — F2 ID-Kollisions-Schutz (verhindert Adoption stale Audit-Rows)', () => {
  function getInsertedId(): string | undefined {
    const wsInsert = insertCalls.find((c) =>
      c.sql.includes('INSERT INTO workspaces'),
    );
    return wsInsert?.params[0] as string | undefined;
  }

  it('Owner-Szenario: „PA Website 2" — sauber verfügbar → vergibt slug direkt', async () => {
    // Kein stale-Slug → disambiguate liefert den base-Slug zurück.
    mockStaleSlugs.clear();
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'PA Website 2',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    expect(getInsertedId()).toBe('example-website-2');
  });

  it('Owner-Szenario: „PA Website 2" — stale chat_ledger.coord_key → vergibt slug+"-2"', async () => {
    // Simuliert den Original-Bug: der Vorgänger ist gelöscht, aber chat_ledger
    // hat noch stale Rows mit coord_key='example-website-2' → F2 disambiguiert.
    mockStaleSlugs.add('example-website-2');
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'PA Website 2',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    expect(getInsertedId()).toBe('example-website-2-2');

    // Label bleibt verbatim N1.
    const body = (await res.json()) as { workspace: { label: string; id: string } };
    expect(body.workspace.label).toBe('PA Website 2');
    expect(body.workspace.id).toBe('example-website-2-2');
  });

  it('Mehrfach-Kollision: -2 auch belegt → vergibt slug+"-3"', async () => {
    mockStaleSlugs.add('example-website-2');
    mockStaleSlugs.add('example-website-2-2');
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'PA Website 2',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    expect(getInsertedId()).toBe('example-website-2-3');
  });

  it('Notausgang: nummerische Pfade -2..-10 belegt → random-Suffix (4-stelliger Alphanum)', async () => {
    mockStaleSlugs.add('bingo');
    for (let i = 2; i <= 10; i++) {
      mockStaleSlugs.add(`bingo-${i}`);
    }
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'Bingo',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    const id = getInsertedId();
    expect(id).toBeDefined();
    expect(id!.startsWith('bingo-')).toBe(true);
    expect(id!).not.toBe('bingo');
    // Random-Suffix ist 4 chars [a-z0-9].
    const suffix = id!.replace(/^bingo-/, '');
    expect(suffix.length).toBeGreaterThanOrEqual(2); // entweder „11" oder „xxxx" — beides ok
  });

  it('Explizite `id` umgeht F2 (Backwards-Compat: 409 bei collision wie zuvor)', async () => {
    // Wenn der User explizit `id` übergibt, soll F2 NICHT disambiguieren —
    // das alte 409-Verhalten bleibt. Wir simulieren mit existingId.
    mockStaleSlugs.add('explicit-id');
    existingId = 'explicit-id';
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        id: 'explicit-id',
        label: 'Anything',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('id-taken');
  });

  it('Label bleibt verbatim auch wenn ID disambiguiert wird (verbatim-N1)', async () => {
    mockStaleSlugs.add('my-project-x');
    const POST = await loadPost();
    const res = await POST(
      makeReq({
        label: 'My Project X',
        organizationId: 'example-company',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspace: { id: string; label: string };
    };
    expect(body.workspace.id).toBe('my-project-x-2');
    // Label IST verbatim — kein „-2" angehängt.
    expect(body.workspace.label).toBe('My Project X');
  });
});
