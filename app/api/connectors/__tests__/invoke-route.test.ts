/**
 * Tests für POST /api/connectors/invoke (ACL5-E · 2026-05-24).
 *
 * Getestet:
 *   (e) /invoke ohne Auth → 401
 *   (e) /invoke ohne echte Membership → 403
 *   (f) /invoke mit Auth + approved=true → executeCall aufgerufen (mock),
 *       LIVE off → dryRun:true in Response
 *   (f) executeCall blockiert (no-profile) → Response enthält blocked-Feld
 *   Bonus: Secret-Leak-Guard: Body darf kein secret-Feld durchlassen
 *
 * Mock-Architektur:
 *   - currentUserIdResolved: konfigurierbar (null | userId).
 *   - getEffectiveWorkspaceRole + canEditWorkspaceContent: standard → 'member' + true.
 *   - hasRealWorkspaceMembership via db.$raw + findOrgForWorkspace.
 *   - executeCall: vi.mock — gibt DryRunCallResult zurück (LIVE off).
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     app/api/connectors/__tests__/invoke-route.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────────

const currentUserIdRef = { value: null as string | null };

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: vi.fn(() => currentUserIdRef.value),
}));

vi.mock('@/lib/security/permissions', () => ({
  getEffectiveWorkspaceRole: vi.fn().mockReturnValue('member'),
  canEditWorkspaceContent: vi.fn().mockReturnValue(true),
}));

// IDOR-Härtung: workspace_memberships-Lookup
const wsMembershipRowsRef = { rows: [] as Array<{ id: string }> };

vi.mock('@/db/client', () => ({
  getDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            all: () => wsMembershipRowsRef.rows,
          }),
        }),
      }),
    }),
  })),
}));

vi.mock('@/db/schema/memberships', () => ({
  workspaceMemberships: { userId: 'userId', workspaceId: 'workspaceId' },
}));

vi.mock('@/lib/orgs/repo', () => ({
  findOrgForWorkspace: vi.fn().mockReturnValue(null),
  findUserOrgMembership: vi.fn().mockReturnValue(null),
}));

// executeCall-Mock — konfigurierbar pro Test
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const executeCallMock = vi.fn(async (_args?: any) => ({
  ok: true as boolean,
  dryRun: true as boolean,
  provider: 'heygen',
  capability: 'render_video',
  simulatedResult: '[DRY-RUN] LAZYOS_CONNECTOR_LIVE ist nicht aktiv.',
  payloadHash: 'b'.repeat(64),
  callId: 'cinvoke-dryrun-test',
}));

vi.mock('@/lib/connectors/invoke', () => ({
  executeCall: (args: unknown) => executeCallMock(args),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Helper: NextRequest bauen
// ──────────────────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/connectors/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Lazy-Import nach Mock-Setup
const { POST } = await import('../invoke/route');

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('POST /api/connectors/invoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentUserIdRef.value = null;
    wsMembershipRowsRef.rows = [];
    // Reset executeCallMock auf Dry-Run-Default
    executeCallMock.mockResolvedValue({
      ok: true as boolean,
      dryRun: true as boolean,
      provider: 'heygen',
      capability: 'render_video',
      simulatedResult: '[DRY-RUN] LAZYOS_CONNECTOR_LIVE ist nicht aktiv.',
      payloadHash: 'b'.repeat(64),
      callId: 'cinvoke-dryrun-test',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── (e) Keine Auth → 401 ──────────────────────────────────────────────────

  it('(e) no auth → 401', async () => {
    currentUserIdRef.value = null;

    const req = makeRequest({
      provider: 'heygen',
      capability: 'render_video',
      workspaceId: 'ws-test',
    });
    const res = await POST(req);

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('auth-required');
    expect(executeCallMock).not.toHaveBeenCalled();
  });

  // ── (e) Auth, aber keine Membership → 403 ────────────────────────────────

  it('(e) authenticated but no real workspace membership → 403', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = []; // keine Membership

    const req = makeRequest({
      provider: 'heygen',
      capability: 'render_video',
      workspaceId: 'ws-test',
    });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(executeCallMock).not.toHaveBeenCalled();
  });

  // ── (f) Auth + Membership + approved=true → executeCall aufgerufen, LIVE off → dryRun:true

  it('(f) authenticated + membership → executeCall called, LIVE off → dryRun:true', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = [{ id: 'user-test' }]; // Membership vorhanden

    const req = makeRequest({
      provider: 'heygen',
      capability: 'render_video',
      workspaceId: 'ws-test',
      payload: { template_id: '<template_id>', ratio: '<number>' },
    });
    const res = await POST(req);

    // executeCall wurde aufgerufen
    expect(executeCallMock).toHaveBeenCalledTimes(1);
    expect(executeCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'heygen',
        capability: 'render_video',
        workspaceId: 'ws-test',
        userId: 'user-test',
        // approved:true ist die User-Bestätigung = Klick auf „Freigeben"
        approved: true,
      }),
    );

    // Response: dryRun:true (LIVE off)
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dryRun: boolean };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
  });

  // ── (f) executeCall blockiert → Response enthält blocked ─────────────────

  it('(f) executeCall blocked (no-profile) → ok:false + blocked in response', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = [{ id: 'user-test' }];

    // executeCall gibt BlockedCallResult zurück
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (executeCallMock as any).mockResolvedValue({
      ok: false,
      blocked: 'no-profile',
      detail: 'Provider nicht im Katalog.',
      callId: 'cinvoke-blocked-test',
    });

    const req = makeRequest({
      provider: 'unknownprovider',
      capability: 'do_something',
      workspaceId: 'ws-test',
    });
    const res = await POST(req);

    expect(res.status).toBe(200); // Route ist 200, Call ist geblockt
    const body = (await res.json()) as { ok: boolean; blocked: string };
    expect(body.ok).toBe(false);
    expect(body.blocked).toBe('no-profile');
  });

  // ── Finding 1 (MEDIUM): blocked-Response leakt KEIN detail / keine Tool-Namen
  it('SECURITY: blocked-Response enthält KEIN detail (S4-Struktur bleibt server-seitig)', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = [{ id: 'user-test' }];

    // executeCall gibt BlockedCallResult mit interner S4-Struktur im detail zurück:
    // hardened.rationale + allowedMcpTools-Liste + erlaubte Capabilities.
    // Genau das, was ein Workspace-Member NICHT per Probing enumerieren darf.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (executeCallMock as any).mockResolvedValue({
      ok: false,
      blocked: 's4-hardening',
      detail:
        'S4: allowedMcpTools=[mcp__heygen__render_video, mcp__heygen__list_avatars]; ' +
        'rationale=capability render_video nicht in coverage; allowedCaps=[list_avatars]',
      callId: 'cinvoke-blocked-s4-test',
    });

    const req = makeRequest({
      provider: 'heygen',
      capability: 'render_video',
      workspaceId: 'ws-test',
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { ok: boolean; blocked: string; detail?: string };

    // Maschinenlesbarer Code ist da
    expect(body.ok).toBe(false);
    expect(body.blocked).toBe('s4-hardening');

    // KEIN detail-Feld im Response-Body
    expect(body).not.toHaveProperty('detail');
    expect(body.detail).toBeUndefined();

    // Keine internen Tool-Namen / rationale im rohen Response-Text
    expect(raw).not.toContain('mcp__heygen');
    expect(raw).not.toContain('allowedMcpTools');
    expect(raw).not.toContain('allowedCaps');
    expect(raw).not.toContain('rationale');
  });

  // ── Finding 2 (LOW): ungültige workspaceId → 400 ──────────────────────────
  it('invalid workspaceId (Kontrollzeichen) → 400, executeCall nicht aufgerufen', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = [{ id: 'user-test' }];

    const req = makeRequest({
      provider: 'heygen',
      capability: 'render_video',
      // Kontrollzeichen / Whitespace / Injection — verletzt WORKSPACE_ID_RE
      workspaceId: 'ws-test\n; DROP TABLE',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_workspace_id');
    expect(executeCallMock).not.toHaveBeenCalled();
  });

  it('invalid workspaceId (überlang >128) → 400', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = [{ id: 'user-test' }];

    const req = makeRequest({
      provider: 'heygen',
      capability: 'render_video',
      workspaceId: 'w'.repeat(129), // > 128 Zeichen
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(executeCallMock).not.toHaveBeenCalled();
  });

  // ── Secret-Leak-Guard: secret-Feld im Body wird herausgefiltert ───────────

  it('secret-Feld im Body wird herausgefiltert, nicht an executeCall übergeben', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = [{ id: 'user-test' }];

    const req = makeRequest({
      provider: 'heygen',
      capability: 'render_video',
      workspaceId: 'ws-test',
      // SECURITY TEST: Angreifer versucht secret im Body mitzuschicken
      payload: {
        template_id: 'safe-value',
        secret: 'sk-verysecretkey12345',  // DARF NICHT an executeCall gelangen
        token: 'bearer-xyz',              // DARF NICHT an executeCall gelangen
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // executeCall-Payload prüfen — safe field muss da sein, secret/token gefiltert
    expect(executeCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({ secret: expect.anything() }),
      }),
    );
    expect(executeCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({ token: expect.anything() }),
      }),
    );
    // safe-value-Feld muss vorhanden sein
    const lastCallArg = (executeCallMock.mock.calls as unknown as Array<[{ payload?: Record<string, unknown> }]>)[0]![0];
    expect(lastCallArg.payload?.template_id).toBe('safe-value');
  });

  // ── Ungültiger Provider → 400 ─────────────────────────────────────────────

  it('invalid provider → 400, executeCall nicht aufgerufen', async () => {
    currentUserIdRef.value = 'user-test';
    wsMembershipRowsRef.rows = [{ id: 'user-test' }];

    const req = makeRequest({
      provider: '../../../etc/passwd', // injection attempt
      capability: 'render_video',
      workspaceId: 'ws-test',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(executeCallMock).not.toHaveBeenCalled();
  });
});
