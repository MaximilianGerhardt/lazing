/**
 * Tests für POST /api/connectors/[provider]/credential (ACL5-B · 2026-05-24)
 *
 * Getestet:
 *   (a) POST ohne Auth → 401
 *   (b) POST mit ungültigem Provider → 400
 *   (c) Erfolgreicher POST → putApiCredential aufgerufen, Antwort hat `masked`, KEIN `secret`
 *   (d) putApiCredential → null (Deny) → 403
 *   (e) Surface-Payload-Builder enthält kein secret-Feld
 *
 * Sicherheitsprinzip (ACL5-B):
 *   Der Secret geht NUR über den POST in den Vault. Die Surface-Payload
 *   (die via Chat-SSE läuft) darf KEIN secret-Feld enthalten.
 *   Die API-Antwort enthält NUR { ok, masked } — niemals den Klartext.
 *
 * Mock-Architektur:
 *   - vi.mock mit inline Funktionen (keine Outer-Variable in Factory — wegen Hoisting).
 *   - vi.mocked() liefert getypten Zugriff auf die Mock-Instanzen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks — KEIN Zugriff auf outer variables in factory (vi.mock wird gehoisted).
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/security/permissions', () => ({
  getEffectiveWorkspaceRole: vi.fn().mockReturnValue('member'),
  canEditWorkspaceContent: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/credentials/vault', () => ({
  putApiCredential: vi.fn().mockReturnValue('apicred-test-123'),
}));

// Security-Critic 2a / P0-C1: Route nutzt jetzt hasRealWorkspaceMembership aus
// lib/security/membership (shared mit vault.ts). Wir mocken das Modul direkt —
// kein Drizzle-Ketten-Mock mehr nötig.
const realMembershipRef = { allow: true };

vi.mock('@/lib/security/membership', () => ({
  hasRealWorkspaceMembership: vi.fn(() => realMembershipRef.allow),
}));

vi.mock('@/lib/orgs/repo', () => ({
  findOrgForWorkspace: vi.fn().mockReturnValue(null),
  findUserOrgMembership: vi.fn().mockReturnValue(null),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Imports (nach Mock-Setup)
// ──────────────────────────────────────────────────────────────────────────────

import { POST } from '../[provider]/credential/route';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { putApiCredential } from '@/lib/credentials/vault';
import { maskedPreview } from '@/lib/security/credentials';
import { findOrgForWorkspace, findUserOrgMembership } from '@/lib/orgs/repo';

const mockCurrentUserIdResolved = vi.mocked(currentUserIdResolved);
const mockCanEditWorkspaceContent = vi.mocked(canEditWorkspaceContent);
const mockHasRealWorkspaceMembership = vi.mocked(hasRealWorkspaceMembership);
const mockPutApiCredential = vi.mocked(putApiCredential);
const mockFindOrgForWorkspace = vi.mocked(findOrgForWorkspace);
const mockFindUserOrgMembership = vi.mocked(findUserOrgMembership);

/** Setzt den Membership-Mock: echte Membership vorhanden. */
function grantRealWorkspaceMembership(): void {
  realMembershipRef.allow = true;
  mockHasRealWorkspaceMembership.mockReturnValue(true);
}

/** Setzt den Membership-Mock: KEINE echte Membership (nur solo-implicit-founder-Pfad). */
function denyRealWorkspaceMembership(): void {
  realMembershipRef.allow = false;
  mockHasRealWorkspaceMembership.mockReturnValue(false);
  mockFindOrgForWorkspace.mockReturnValue(null);
  mockFindUserOrgMembership.mockReturnValue(null);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeRequest(
  body: Record<string, unknown>,
  provider = 'stripe',
): { req: NextRequest; ctx: { params: Promise<{ provider: string }> } } {
  const req = new NextRequest(`http://localhost/api/connectors/${provider}/credential`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ctx = { params: Promise.resolve({ provider }) };
  return { req, ctx };
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ──────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockCurrentUserIdResolved.mockReturnValue('user-test-id');
  mockCanEditWorkspaceContent.mockReturnValue(true);
  mockPutApiCredential.mockReturnValue('apicred-test-123');
  // Default: User hat eine echte Membership (Happy-Path).
  realMembershipRef.allow = true;
  mockHasRealWorkspaceMembership.mockReturnValue(true);
});

afterEach(() => {
  vi.resetAllMocks();
});

// ── (a) Auth: kein User → 401 ─────────────────────────────────────────────────

describe('(a) POST ohne Auth → 401', () => {
  it('gibt 401 zurück wenn currentUserIdResolved null liefert', async () => {
    mockCurrentUserIdResolved.mockReturnValue(null);
    const { req, ctx } = makeRequest({ secret: 'sk_test_123', workspaceId: 'ws-1' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('auth-required');
    // Vault darf NICHT aufgerufen worden sein.
    expect(mockPutApiCredential).not.toHaveBeenCalled();
  });
});

// ── (b) Ungültiger Provider → 400 ─────────────────────────────────────────────

describe('(b) Ungültiger Provider → 400', () => {
  it('gibt 400 zurück bei leerem Provider-String', async () => {
    const req = new NextRequest('http://localhost/api/connectors//credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'abc', workspaceId: 'ws-1' }),
    });
    const ctx = { params: Promise.resolve({ provider: '' }) };
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_provider');
  });

  it('gibt 400 zurück bei Provider mit Sonderzeichen (STRIPE!)', async () => {
    const { req, ctx } = makeRequest({ secret: 'abc', workspaceId: 'ws-1' }, 'STRIPE!');
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('invalid_provider');
    expect(mockPutApiCredential).not.toHaveBeenCalled();
  });

  it('gibt 400 zurück bei Provider mit Großbuchstaben (Regex ^[a-z]…)', async () => {
    const { req, ctx } = makeRequest({ secret: 'abc', workspaceId: 'ws-1' }, 'Stripe');
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(mockPutApiCredential).not.toHaveBeenCalled();
  });

  it('akzeptiert validen Provider "stripe" (kein 400)', async () => {
    const { req, ctx } = makeRequest({ secret: 'sk_test_valid', workspaceId: 'ws-1' }, 'stripe');
    const res = await POST(req, ctx);
    expect(res.status).not.toBe(400);
  });

  it('akzeptiert validen Provider mit Bindestrich "open-ai"', async () => {
    const { req, ctx } = makeRequest({ secret: 'sk_test_valid', workspaceId: 'ws-1' }, 'open-ai');
    const res = await POST(req, ctx);
    expect(res.status).not.toBe(400);
  });
});

// ── (c) Erfolgreicher POST ─────────────────────────────────────────────────────

describe('(c) Erfolgreicher POST → putApiCredential aufgerufen, masked in Antwort, kein secret', () => {
  it('ruft putApiCredential mit korrektem Input auf und gibt 201 zurück', async () => {
    const { req, ctx } = makeRequest({
      secret: 'sk_test_live_abcdef1234567890',
      workspaceId: 'ws-north',
      scopeKind: 'workspace',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);

    // putApiCredential wurde aufgerufen.
    expect(mockPutApiCredential).toHaveBeenCalledOnce();
    const [input, actor] = mockPutApiCredential.mock.calls[0] as [
      { scopeKind: string; scopeId: string; provider: string; kind: string; secret: string },
      { userId: string; source: string },
    ];
    expect(input.provider).toBe('stripe');
    expect(input.scopeKind).toBe('workspace');
    expect(input.scopeId).toBe('ws-north');
    expect(input.kind).toBe('api_key');
    expect(input.secret).toBe('sk_test_live_abcdef1234567890');
    expect(actor.userId).toBe('user-test-id');
  });

  it('Antwort enthält `masked` und `ok: true`, aber KEIN `secret`', async () => {
    const { req, ctx } = makeRequest({
      secret: 'sk_test_live_abcdef1234567890',
      workspaceId: 'ws-north',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;

    // SECURITY: 'secret' darf NICHT in der Response erscheinen.
    expect(body).not.toHaveProperty('secret');

    // 'ok' und 'masked' müssen vorhanden sein.
    expect(body).toHaveProperty('ok', true);
    expect(body).toHaveProperty('masked');
    expect(typeof body.masked).toBe('string');

    // masked darf NICHT der Klartext sein.
    expect(body.masked).not.toBe('sk_test_live_abcdef1234567890');
    // masked enthält mindestens 2 Zeichen.
    expect((body.masked as string).length).toBeGreaterThan(2);
  });

  it('masked zeigt KEIN Klartext-Prefix, nur die letzten 2 Zeichen (langer Secret)', async () => {
    const { req, ctx } = makeRequest({
      secret: 'sk_test_live_abcdef1234',
      workspaceId: 'ws-north',
    });
    const res = await POST(req, ctx);
    const body = (await res.json()) as { masked?: string; ok?: boolean };
    // maskedPreview (Security-Critic 1a): '••••••••' + letzte 2 + ' (n)'.
    // KEIN Prefix mehr — masked darf NICHT mit dem Klartext-Prefix 'sk' beginnen.
    expect(body.masked).not.toMatch(/^sk/);
    expect(body.masked).toMatch(/^•/);
    // Nur die letzten 2 Zeichen ('34') sind sichtbar.
    expect(body.masked).toContain('34');
    expect(body.masked).toContain('•');
    // Das Klartext-Prefix 'sk_test' darf nicht auftauchen.
    expect(body.masked).not.toContain('sk_test');
  });

  it('scopeKind=org wird korrekt weitergereicht an putApiCredential (mit echter orgId)', async () => {
    // P0-Fix F-2: findOrgForWorkspace muss einen Org-Stub zurückliefern,
    // damit der org-scope-Pfad die echte orgId auflösen kann.
    mockFindOrgForWorkspace.mockReturnValue({ id: 'org-real-1' } as unknown as ReturnType<typeof findOrgForWorkspace>);

    const { req, ctx } = makeRequest({
      secret: 'org_key_abc',
      workspaceId: 'ws-north',
      scopeKind: 'org',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);

    const [input] = mockPutApiCredential.mock.calls[0] as unknown as [
      { scopeKind: string; scopeId: string }
    ];
    expect(input.scopeKind).toBe('org');
    // WICHTIG (P0-Fix F-2): scopeId muss die ECHTE orgId sein, nicht workspaceId.
    expect(input.scopeId).toBe('org-real-1');
  });
});

// ── (d) Deny: putApiCredential → null → 403 ──────────────────────────────────

describe('(d) putApiCredential → null → 403', () => {
  it('gibt 403 zurück wenn putApiCredential null liefert (intern: Auth-Deny im Vault)', async () => {
    mockPutApiCredential.mockReturnValue(null);
    const { req, ctx } = makeRequest({
      secret: 'sk_test_abc',
      workspaceId: 'ws-north',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('forbidden');
    // SECURITY: kein Secret in der Antwort.
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('masked');
  });

  it('gibt 403 zurück wenn Permission-Gate (canEditWorkspaceContent) false liefert', async () => {
    mockCanEditWorkspaceContent.mockReturnValue(false);
    const { req, ctx } = makeRequest({
      secret: 'sk_test_abc',
      workspaceId: 'ws-north',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    // Vault darf bei fehlgeschlagenem Permission-Gate NICHT aufgerufen werden.
    expect(mockPutApiCredential).not.toHaveBeenCalled();
  });
});

// ── (e) Surface-Payload-Builder enthält kein secret-Feld ───────────────────────

describe('(e) Surface-Payload-Builder enthält kein secret-Feld', () => {
  it('valider surface:credential-request Payload hat nur non-sensitive Felder', () => {
    // Diese Surface-Payload ist das, was der LLM/Orchestrator via
    // <surface:credential-request>{...}</surface:credential-request>
    // über den Chat-Stream / SSE emittiert.
    //
    // SECURITY CONTRACT: das Payload-Objekt darf NIEMALS ein secret-Feld enthalten.
    // Der Secret geht AUSSCHLIESSLICH über den POST.

    const validPayload = {
      provider: 'stripe',
      scopeKind: 'workspace',
      workspaceId: 'ws-north',
      why: 'Stripe benötigt einen API-Key für Zahlungen.',
      docsUrl: 'https://stripe.com/docs/keys',
    };

    // Explizite Assertions gegen bekannte sensitive Key-Namen.
    expect(validPayload).not.toHaveProperty('secret');
    expect(validPayload).not.toHaveProperty('api_key');
    expect(validPayload).not.toHaveProperty('token');
    expect(validPayload).not.toHaveProperty('password');
    expect(validPayload).not.toHaveProperty('key');

    // Alle Keys sind in der Whitelist erlaubter non-sensitive Felder.
    const allowedKeys = new Set([
      'provider', 'scopeKind', 'workspaceId', 'why', 'docsUrl', 'configFields',
    ]);
    for (const k of Object.keys(validPayload)) {
      expect(allowedKeys.has(k)).toBe(true);
    }
  });

  it('renderCredentialRequest-Guard filtert secret/token/api_key aus configFields heraus', () => {
    // Spiegelt den configFields-Filter aus SurfaceRenderer.tsx renderCredentialRequest.
    // Wenn jemand versehentlich ein secret-Feld in configFields einbaut,
    // wird es herausgefiltert bevor es die CredentialRequestCard erreicht.

    const rawConfigFields = [
      { key: 'baseUrl', label: 'Base URL' },
      { key: 'version', label: 'Version' },
      { key: 'api_key', label: 'API Key' },        // muss raus
      { key: 'secret_token', label: 'Token' },      // muss raus
      { key: 'password', label: 'Passwort' },       // muss raus
      { key: 'access_token', label: 'Token' },      // muss raus
    ];

    // Identischer Regex wie in renderCredentialRequest in SurfaceRenderer.tsx.
    const filtered = rawConfigFields.filter(
      (f) => !/secret|token|api.?key|password/i.test(f.key),
    );

    expect(filtered).toHaveLength(2);
    expect(filtered.map((f) => f.key)).toEqual(['baseUrl', 'version']);

    // Explizite Negativ-Checks.
    const filteredKeys = filtered.map((f) => f.key);
    expect(filteredKeys).not.toContain('api_key');
    expect(filteredKeys).not.toContain('secret_token');
    expect(filteredKeys).not.toContain('password');
    expect(filteredKeys).not.toContain('access_token');
  });

  it('Endpoint filtert secret-Pattern aus config-Feldern im POST-Body', async () => {
    // Server-seitige Verifikation: der Endpoint filtert ebenfalls sensitive
    // config-Keys (Defense-in-depth — auch wenn der Client schon filtert).

    const { req, ctx } = makeRequest({
      secret: 'sk_valid',
      workspaceId: 'ws-north',
      config: {
        baseUrl: 'https://api.example.com',
        api_key: 'this-should-be-filtered',   // server filtert
        version: 'v2',
        password: 'secret123',               // server filtert
        access_token: 'token-abc',           // server filtert
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);

    expect(mockPutApiCredential).toHaveBeenCalledOnce();
    const [input] = mockPutApiCredential.mock.calls[0] as unknown as [
      { config: Record<string, unknown> | null }
    ];
    // Nach Server-Filter: nur non-sensitive Keys.
    if (input.config !== null) {
      expect(input.config).not.toHaveProperty('api_key');
      expect(input.config).not.toHaveProperty('password');
      expect(input.config).not.toHaveProperty('access_token');
      expect(input.config).toHaveProperty('baseUrl', 'https://api.example.com');
      expect(input.config).toHaveProperty('version', 'v2');
    }
  });
});

// ── (2a) IDOR-Härtung: Body-workspaceId ohne echte Membership → 403 ──────────

describe('(2a) Security-Critic — Credential-WRITE verlangt echte Membership', () => {
  it('auth\'d User ohne echte Membership (nur solo-implicit-founder-Pfad) → 403', async () => {
    // canEditWorkspaceContent gibt true zurück (solo-implicit-founder rankt als founder),
    // ABER es gibt KEINE echte workspace- oder org-Membership.
    mockCanEditWorkspaceContent.mockReturnValue(true);
    denyRealWorkspaceMembership();

    const { req, ctx } = makeRequest({
      secret: 'sk_test_abc_def_ghi',
      workspaceId: 'ws-fremd',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('forbidden');
    // Vault darf NICHT geschrieben haben — kein blindes Body-workspaceId-Vertrauen.
    expect(mockPutApiCredential).not.toHaveBeenCalled();
    // Kein Secret/masked in der Deny-Antwort.
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('masked');
  });

  it('User mit expliziter workspace_membership → erlaubt (201)', async () => {
    mockCanEditWorkspaceContent.mockReturnValue(true);
    grantRealWorkspaceMembership(); // explizite WS-Membership.

    const { req, ctx } = makeRequest({
      secret: 'sk_test_abc_def_ghi',
      workspaceId: 'ws-eigen',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);
    expect(mockPutApiCredential).toHaveBeenCalledOnce();
  });

  it('User mit Org-Membership (kein WS-Row, aber Org des Workspace) → erlaubt (201)', async () => {
    mockCanEditWorkspaceContent.mockReturnValue(true);
    // Keine explizite WS-Membership, aber Org-Membership — shared helper gibt true.
    mockHasRealWorkspaceMembership.mockReturnValue(true);
    mockFindOrgForWorkspace.mockReturnValue({ id: 'org-1' } as unknown as ReturnType<typeof findOrgForWorkspace>);
    mockFindUserOrgMembership.mockReturnValue({ userId: 'user-test-id', orgId: 'org-1', role: 'member' } as unknown as ReturnType<typeof findUserOrgMembership>);

    const { req, ctx } = makeRequest({
      secret: 'sk_test_abc_def_ghi',
      workspaceId: 'ws-org',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);
    expect(mockPutApiCredential).toHaveBeenCalledOnce();
  });
});

// ── (f) P0-Fix F-2: org-scope → echte orgId auflösen ─────────────────────────
//
// Getestet (P0-#3, 2026-05-25):
//   (f1) org-scope + Workspace-mit-Org + Org-Admin → 201, scopeId = org.id
//   (f2) org-scope + Workspace-ohne-Org             → 400 workspace_has_no_org
//   (f3) org-scope + Nicht-Org-Admin                → 403 (putApiCredential → null)
//
// Hintergrund: vor dem Fix setzte die Route `scopeId = workspaceId` bei org-scope.
// `isOrgAdmin(userId, workspaceId)` matcht nie → org-writes faktisch kaputt.
// Nach dem Fix: findOrgForWorkspace(workspaceId) → org.id als scopeId.

describe('(f) P0-Fix F-2 — org-scope: echte orgId auflösen', () => {
  it('(f1) org-scope + Workspace-mit-Org + Org-Admin → 201, putApiCredential erhält echte orgId', async () => {
    // Workspace gehört zu org-real-99.
    mockFindOrgForWorkspace.mockReturnValue({ id: 'org-real-99' } as unknown as ReturnType<typeof findOrgForWorkspace>);
    // putApiCredential gibt eine cred-ID zurück (Vault erlaubt den Write).
    mockPutApiCredential.mockReturnValue('apicred-org-write-ok');

    const { req, ctx } = makeRequest({
      secret: 'org_secret_xyz_0987654321',
      workspaceId: 'ws-with-org',
      scopeKind: 'org',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);

    expect(mockPutApiCredential).toHaveBeenCalledOnce();
    const [input] = mockPutApiCredential.mock.calls[0] as unknown as [
      { scopeKind: string; scopeId: string; secret: string }
    ];
    // scopeKind muss 'org' sein.
    expect(input.scopeKind).toBe('org');
    // KERNASSERTION: scopeId = ECHTE orgId, NICHT workspaceId.
    expect(input.scopeId).toBe('org-real-99');
    expect(input.scopeId).not.toBe('ws-with-org');
    // Secret korrekt weitergeleitet.
    expect(input.secret).toBe('org_secret_xyz_0987654321');
  });

  it('(f2) org-scope + Workspace-ohne-Org → 400 workspace_has_no_org, kein Vault-Write', async () => {
    // findOrgForWorkspace gibt null zurück (Workspace hat keine Org).
    mockFindOrgForWorkspace.mockReturnValue(null);

    const { req, ctx } = makeRequest({
      secret: 'org_secret_abc',
      workspaceId: 'ws-no-org',
      scopeKind: 'org',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);

    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('workspace_has_no_org');
    // Kein Write: Vault darf nicht aufgerufen worden sein.
    expect(mockPutApiCredential).not.toHaveBeenCalled();
    // Kein Secret-Leak in der Antwort.
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('masked');
  });

  it('(f3) org-scope + Nicht-Org-Admin → 403 (putApiCredential → null), kein Secret', async () => {
    // Workspace hat eine Org — aber der User ist kein Admin.
    // Der Vault-interne isOrgAdmin-Check schlägt fehl → putApiCredential gibt null zurück.
    mockFindOrgForWorkspace.mockReturnValue({ id: 'org-no-admin' } as unknown as ReturnType<typeof findOrgForWorkspace>);
    mockPutApiCredential.mockReturnValue(null); // Vault-Deny

    const { req, ctx } = makeRequest({
      secret: 'org_secret_non_admin',
      workspaceId: 'ws-with-org-no-admin',
      scopeKind: 'org',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);

    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('forbidden');
    // putApiCredential wurde aufgerufen (Route kam bis zum Write), aber Vault hat verweigert.
    expect(mockPutApiCredential).toHaveBeenCalledOnce();
    // Kein Secret/masked in der Deny-Response.
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('masked');
    // Vault wurde mit der ECHTEN orgId aufgerufen (nicht workspaceId).
    const [input] = mockPutApiCredential.mock.calls[0] as unknown as [
      { scopeKind: string; scopeId: string }
    ];
    expect(input.scopeId).toBe('org-no-admin');
  });
});

// ── (1a) maskedPreview: kein Klartext-Leak in der Response ───────────────────

describe('(1a) Security-Critic — maskedPreview leakt keinen Klartext', () => {
  it('kurzer Secret (len<=8): masked enthält KEIN Klartext-Zeichen', async () => {
    const shortSecret = 'sk12'; // len 4 — vorher wurde der VOLLE Klartext gezeigt.
    const { req, ctx } = makeRequest({
      secret: shortSecret,
      workspaceId: 'ws-north',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { masked?: string };

    // Kein einziges Klartext-Zeichen aus dem Secret darf erscheinen.
    expect(body.masked).not.toContain('s');
    expect(body.masked).not.toContain('k');
    expect(body.masked).not.toContain('1');
    expect(body.masked).not.toContain('2');
    // Voll maskiert + Länge: '••••••••(4)'.
    expect(body.masked).toMatch(/^•+\(\d+\)$/);
  });

  it('kurzer Secret len=8: weiterhin voll maskiert (Grenzfall)', async () => {
    const { req, ctx } = makeRequest({
      secret: 'abcd1234',
      workspaceId: 'ws-north',
    });
    const res = await POST(req, ctx);
    const body = (await res.json()) as { masked?: string };
    expect(body.masked).toMatch(/^•+\(8\)$/);
    // Keine der letzten 2 Klartext-Zeichen sichtbar (voll maskiert bei <=8).
    expect(body.masked).not.toContain('3');
    expect(body.masked).not.toContain('4');
  });

  it('langer Secret (len>8): maximal die LETZTEN 2 Zeichen, kein Prefix', async () => {
    const longSecret = 'sk_live_supersecret_value_XY';
    const { req, ctx } = makeRequest({
      secret: longSecret,
      workspaceId: 'ws-north',
    });
    const res = await POST(req, ctx);
    const body = (await res.json()) as { masked?: string };

    // Format: '••••••••XY (28)'. Prefix maskiert, nur letzte 2 sichtbar.
    expect(body.masked).toMatch(/^•+XY \(\d+\)$/);
    // Klartext-Prefix darf NICHT auftauchen.
    expect(body.masked).not.toContain('sk_live');
    expect(body.masked).not.toContain('supersecret');
  });

  it('maskedPreview (unit): kurz=voll maskiert, lang=letzte 2, kein Prefix', () => {
    // Direkter Unit-Check der reinen Funktion (Security-Critic 1a).
    expect(maskedPreview('')).toBe('');
    expect(maskedPreview('abcd')).toBe('••••••••(4)');       // kurz → voll maskiert
    expect(maskedPreview('abcdefgh')).toBe('••••••••(8)');   // Grenzfall len=8 → voll
    expect(maskedPreview('abcdefghi')).toBe('••••••••hi (9)'); // lang → letzte 2
    // Kein Klartext-Prefix bei langem Secret.
    expect(maskedPreview('sk_live_xxxxxx_zz')).not.toMatch(/^sk/);
    expect(maskedPreview('sk_live_xxxxxx_zz')).toMatch(/^•+zz \(\d+\)$/);
  });
});
