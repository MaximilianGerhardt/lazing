/**
 * Tests für maybeAutoConnect — ACL5-E (2026-05-24).
 *
 * Getestet (6 Szenarien):
 *   (a) missing='no-connector' → no-op (return {acted:false})
 *   (b) missing='credential' → credential-request-Card emittiert, KEIN secret im Card-Payload
 *   (c) missing='profile' → onboarding angestoßen (Onboarding-Toast emittiert)
 *   (d) missing='none' + Call impliziert → preview-Card mit Approve-Action emittiert
 *   (e) preview-Card-Payload enthält kein secret/token-Feld (SECURITY)
 *   (f) emitOrUpdateCard wurde für credential-request mit richtigem surfaceKind aufgerufen
 *
 * Mock-Architektur:
 *   - detectConnector: vi.mock('@/lib/connectors/detect') — konfigurierbar pro Test.
 *   - previewCall: vi.mock('@/lib/connectors/invoke') — gibt CallPreview-Fake zurück.
 *   - emitOrUpdateCard: vi.mock('@/lib/events/emit-or-update-card') — spy für Assertions.
 *   - DB für hasCredential: vi.mock('@/db/client') — COUNT-Query antwortet konfigurierbar.
 *   - listSops: vi.mock('@/lib/sop/registry') — gibt leeres Array zurück.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/connectors/__tests__/auto-connect.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────────

// Kontrolle: wie soll detectConnector antworten?
const detectResultRef = {
  provider: null as string | null,
  missing: 'no-connector' as 'no-connector' | 'profile' | 'credential' | 'none',
  neededCapabilities: [] as string[],
  confidence: 0,
  rationale: 'test',
};

vi.mock('@/lib/connectors/detect', () => ({
  detectConnector: vi.fn((_prompt: unknown, _ctx: unknown) => ({
    provider: detectResultRef.provider,
    missing: detectResultRef.missing,
    neededCapabilities: detectResultRef.neededCapabilities,
    confidence: detectResultRef.confidence,
    rationale: detectResultRef.rationale,
  })),
}));

// previewCall-Fake (S5, kein Secret).
const previewCallMock = vi.fn((_args?: unknown) => ({
  ok: true as const,
  provider: 'heygen',
  capability: 'render_video',
  mcpTool: 'mcp__heygen__render_video',
  baseUrl: 'https://api.heygen.com',
  payloadSummary: { template_id: 'string', ratio: 'number' },
  credentialScope: 'workspace:ws-test',
  credentialPreview: 'sk••••••••xy (32)',
  authKind: 'api_key',
  payloadHash: 'a'.repeat(64),
  currentTrust: 'ask' as const,
  liveEnabled: false,
  callId: 'cinvoke-test123',
}));

vi.mock('@/lib/connectors/invoke', () => ({
  previewCall: (args: unknown) => previewCallMock(args),
}));

// emitOrUpdateCard — spy
const emitMock = vi.fn(async (_args: unknown) => ({
  event: { id: 'evt-test' },
  mode: 'inserted' as const,
}));

vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: (args: unknown) => emitMock(args),
}));

// DB — COUNT-Query für hasCredential
const dbCountRef = { n: 0 };

vi.mock('@/db/client', () => ({
  getDb: vi.fn(() => ({
    $raw: {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ n: dbCountRef.n })),
      })),
    },
    // Drizzle-Select-Chain (für Membership-Checks falls nötig)
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            all: vi.fn(() => []),
          })),
        })),
      })),
    })),
  })),
}));

// listSops — leer (kein SOP-Lookup im Test relevant)
vi.mock('@/lib/sop/registry', () => ({
  listSops: vi.fn(() => []),
}));

// workspaceMemberships-Schema-Import (nicht wirklich genutzt, nur damit der Import passt)
vi.mock('@/db/schema/memberships', () => ({
  workspaceMemberships: { userId: 'userId', workspaceId: 'workspaceId' },
}));

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

// Lazy-import nach Mock-Setup
const { maybeAutoConnect } = await import('../auto-connect');

const CTX = { workspaceId: 'ws-test', userId: 'user-test' };

describe('maybeAutoConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset auf Defaults
    detectResultRef.provider = null;
    detectResultRef.missing = 'no-connector';
    detectResultRef.neededCapabilities = [];
    detectResultRef.confidence = 0;
    dbCountRef.n = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── (a) no-connector → no-op ─────────────────────────────────────────────

  it('(a) missing=no-connector → no-op, emitOrUpdateCard nicht aufgerufen', async () => {
    detectResultRef.missing = 'no-connector';
    detectResultRef.provider = null;

    const result = await maybeAutoConnect('Wie ist das Wetter heute?', CTX);

    expect(result.acted).toBe(false);
    expect(emitMock).not.toHaveBeenCalled();
    expect(previewCallMock).not.toHaveBeenCalled();
  });

  it('(a) provider=null → no-op auch wenn missing nicht no-connector wäre', async () => {
    detectResultRef.missing = 'no-connector';
    detectResultRef.provider = null;
    detectResultRef.confidence = 0;

    const result = await maybeAutoConnect('irgendwas', CTX);
    expect(result.acted).toBe(false);
    expect(emitMock).not.toHaveBeenCalled();
  });

  // ── (b) missing='credential' → credential-request-Card, KEIN secret ──────

  it('(b) missing=credential → credential-request-Card emittiert', async () => {
    detectResultRef.provider = 'heygen';
    detectResultRef.missing = 'credential';
    detectResultRef.neededCapabilities = ['render_video'];
    detectResultRef.confidence = 1.0;

    const result = await maybeAutoConnect(
      'Erstelle ein Video mit HeyGen',
      CTX,
    );

    expect(result.acted).toBe(true);
    if (result.acted) {
      expect(result.action).toBe('credential-request');
      expect(result.provider).toBe('heygen');
    }

    // emitOrUpdateCard muss einmal aufgerufen worden sein
    expect(emitMock).toHaveBeenCalledTimes(1);

    const callArgs = emitMock.mock.lastCall![0] as {
      coords: { surfaceKind: string };
      content: string;
    };

    // Richtige Surface-Kind
    expect(callArgs.coords.surfaceKind).toBe('credential-request');

    // SECURITY: der Content-String (der via SSE läuft) darf kein secret-FELD
    // (JSON-Key) enthalten. Wir prüfen auf die Key-Form `"<key>":` — der
    // authKind-WERT 'apikey' (ein Auth-Art-Label, kein Secret) ist erlaubt.
    const content = callArgs.content;
    expect(content).not.toMatch(/"secret"\s*:/i);
    expect(content).not.toMatch(/"token"\s*:/i);
    expect(content).not.toMatch(/"api_key"\s*:/i);
    expect(content).not.toMatch(/"password"\s*:/i);
    expect(content).not.toMatch(/"apiKey"\s*:/i);
  });

  it('(b) credential-request-Card enthält provider + workspaceId, KEIN secret-Feld', async () => {
    detectResultRef.provider = 'stripe';
    detectResultRef.missing = 'credential';
    detectResultRef.neededCapabilities = ['create_payment'];

    await maybeAutoConnect('Zahlung via Stripe anlegen', CTX);

    const callArgs2 = emitMock.mock.lastCall![0] as { content: string };
    const content = callArgs2.content;

    // Inhalt: provider + workspaceId vorhanden
    expect(content).toContain('stripe');
    expect(content).toContain('ws-test');

    // SECURITY-Assertion: kein secret/token/key/password im Card-Content
    const FORBIDDEN = ['secret', 'password', 'private_key', 'access_token', 'client_secret'];
    for (const forbidden of FORBIDDEN) {
      // Regex: prüft ob der String als JSON-Key auftaucht (mit Anführungszeichen)
      expect(content).not.toMatch(new RegExp(`"${forbidden}"`));
    }
  });

  // ── (c) missing='profile' → onboarding angestoßen ────────────────────────

  it('(c) missing=profile → Onboarding-Toast emittiert', async () => {
    detectResultRef.provider = 'someunknown';
    detectResultRef.missing = 'profile';
    detectResultRef.neededCapabilities = ['do_something'];

    const result = await maybeAutoConnect('someunknown api aufrufen', CTX);

    expect(result.acted).toBe(true);
    if (result.acted) {
      expect(result.action).toBe('onboarding');
      expect(result.provider).toBe('someunknown');
    }

    // Toast-Card emittiert
    expect(emitMock).toHaveBeenCalledTimes(1);
    const callArgs = emitMock.mock.lastCall![0] as {
      coords: { surfaceKind: string };
      content: string;
    };
    expect(callArgs.coords.surfaceKind).toBe('toast');
    // Inhalt: Provider-Name in der Card
    expect(callArgs.content).toContain('someunknown');
  });

  // ── (d) missing='none' → preview-Card mit Approve-Action ─────────────────

  it('(d) missing=none → preview-Card emittiert, previewCall aufgerufen', async () => {
    detectResultRef.provider = 'heygen';
    detectResultRef.missing = 'none';
    detectResultRef.neededCapabilities = ['render_video'];
    detectResultRef.confidence = 1.0;
    dbCountRef.n = 1; // Credential existiert

    const result = await maybeAutoConnect(
      'Erstelle ein Video mit HeyGen Avatar',
      CTX,
    );

    expect(result.acted).toBe(true);
    if (result.acted) {
      expect(result.action).toBe('preview');
      expect(result.provider).toBe('heygen');
    }

    // previewCall muss aufgerufen worden sein
    expect(previewCallMock).toHaveBeenCalledTimes(1);
    // Argument ist das InvokeArgs-Objekt
    expect(previewCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'heygen',
        capability: 'render_video',
        workspaceId: 'ws-test',
      }),
    );

    // connector-call-preview-Card emittiert
    expect(emitMock).toHaveBeenCalledTimes(1);
    const callArgs = emitMock.mock.lastCall![0] as {
      coords: { surfaceKind: string };
      content: string;
    };
    expect(callArgs.coords.surfaceKind).toBe('connector-call-preview');
  });

  // ── (e) SECURITY: preview-Card-Payload enthält kein secret ────────────────

  it('(e) SECURITY: preview-Card-Content enthält kein secret/token/key', async () => {
    detectResultRef.provider = 'heygen';
    detectResultRef.missing = 'none';
    detectResultRef.neededCapabilities = ['render_video'];

    await maybeAutoConnect('Heygen video', CTX);

    const callArgs = emitMock.mock.lastCall![0] as { content: string };
    const content = callArgs.content;

    // credentialPreview darf vorkommen (maskiert), aber kein Klartext-secret
    // Der Fake-credentialPreview ist 'sk••••••••xy (32)' — kein echter Key
    expect(content).toContain('sk••••••••xy');

    // Kein secret/token/password als JSON-Key (Pattern: "key": — mit Doppelpunkt)
    // authKind:"api_key" ist ein erlaubter Enum-WERT, nicht ein Key-Name
    const FORBIDDEN_KEY_PATTERNS = ['"secret":', '"api_key":', '"apiKey":', '"password":', '"private_key":'];
    for (const pattern of FORBIDDEN_KEY_PATTERNS) {
      expect(content).not.toContain(pattern);
    }
  });

  // ── (f) emitOrUpdateCard surfaceKind-Mapping korrekt ─────────────────────

  it('(f) credential-request → surfaceKind=credential-request im coords', async () => {
    detectResultRef.provider = 'openai';
    detectResultRef.missing = 'credential';
    detectResultRef.neededCapabilities = ['chat_completion'];

    await maybeAutoConnect('GPT-4 via OpenAI', CTX);

    const callArgs = emitMock.mock.lastCall![0] as {
      coords: { surfaceKind: string; workspaceId: string; workstreamId: string };
    };
    expect(callArgs.coords.surfaceKind).toBe('credential-request');
    expect(callArgs.coords.workspaceId).toBe('ws-test');
    // workstreamId ist deterministisch: 'acl5e-connector-openai'
    expect(callArgs.coords.workstreamId).toBe('acl5e-connector-openai');
  });
});
