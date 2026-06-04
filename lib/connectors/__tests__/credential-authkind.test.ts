/**
 * lib/connectors/__tests__/credential-authkind.test.ts
 *
 * Test für die Auth-Profil-Anreicherung der credential-request-Surface
 * (2026-05-30): maybeAutoConnect leitet authKind (apikey | oauth | none) aus
 * dem Connector-Katalog (auth_kind) + Onboarding-SOP ab und legt es — plus
 * docs/signup/hint — in den credential-request-Card-Payload. KEIN Secret.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/connectors/__tests__/credential-authkind.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { WORKSPACE_ID } = vi.hoisted(() => ({ WORKSPACE_ID: 'ws-authkind-001' }));

// Steuerbare Katalog-/SOP-Rückgaben.
const catState = vi.hoisted(() => ({
  authKind: null as string | null,
  docsUrl: null as string | null,
  sop: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/connectors/catalog', () => ({
  getConnectorProfile: vi.fn(() =>
    catState.authKind === null && catState.docsUrl === null
      ? null
      : { authKind: catState.authKind, docsUrl: catState.docsUrl },
  ),
}));
vi.mock('@/lib/connectors/onboarding-sop', () => ({
  getOnboardingSop: vi.fn(() => catState.sop),
}));

const mockEmitOrUpdateCard = vi.fn(async (_a: unknown) => ({
  event: { id: 'evt' }, mode: 'inserted' as const,
}));
vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: (a: unknown) => mockEmitOrUpdateCard(a),
}));

vi.mock('@/lib/push/triggers', () => ({ emitAnswerRequired: vi.fn() }));

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ n: 0 })) })),
      transaction: (fn: () => void) => () => fn(),
    },
  }),
}));

vi.mock('@/lib/connectors/detect', () => ({ detectConnector: vi.fn() }));
vi.mock('@/lib/connectors/invoke', () => ({ previewCall: vi.fn() }));
vi.mock('@/lib/sop/registry', () => ({ listSops: vi.fn(() => []), getSop: vi.fn() }));
vi.mock('@/lib/sop/executor', () => ({ expandSopToPlanNodes: vi.fn(() => []) }));
vi.mock('@/lib/workstreams/service', () => ({ createWorkstream: vi.fn(), getWorkstream: vi.fn(), updateWorkstream: vi.fn() }));
vi.mock('@/lib/workstreams/plan-repo', () => ({ insertProposedPlan: vi.fn(), listRootPlanSteps: vi.fn(() => []), setPlanStepStatus: vi.fn() }));
vi.mock('@/lib/workstreams/plan-executor', () => ({ executePlan: vi.fn() }));
vi.mock('@/lib/workstreams/trace-repo', () => ({ writeDecision: vi.fn(), writeEvidence: vi.fn() }));
vi.mock('@/lib/ulid', () => ({ ulid: () => 'mock' }));
vi.mock('@/db/schema/memberships', () => ({ workspaceMemberships: {} }));

const { maybeAutoConnect } = await import('../auto-connect');
const BASE_CTX = { workspaceId: WORKSPACE_ID, userId: 'u-1' };

async function driveCredentialMissing(provider: string): Promise<Record<string, unknown>> {
  const { detectConnector } = await import('@/lib/connectors/detect');
  (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    provider, missing: 'credential', neededCapabilities: ['video.avatar'],
    confidence: 0.9, rationale: `${provider}`,
  });
  await maybeAutoConnect(`Nutze ${provider}`, BASE_CTX);
  const card = mockEmitOrUpdateCard.mock.calls.find((c) => {
    const a = c[0] as { coords: { surfaceKind: string } };
    return a.coords.surfaceKind === 'credential-request';
  });
  expect(card).toBeDefined();
  const content = (card![0] as { content: string }).content;
  const json = content.replace(/^<surface:credential-request>/, '').replace(/<\/surface:credential-request>$/, '');
  return JSON.parse(json) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  catState.authKind = null;
  catState.docsUrl = null;
  catState.sop = null;
});
afterEach(() => vi.clearAllMocks());

describe('credential-request Auth-Profil-Anreicherung (2026-05-30)', () => {
  it('auth_kind=api_key → authKind="apikey" im Payload', async () => {
    catState.authKind = 'api_key';
    const payload = await driveCredentialMissing('heygen-avatar');
    expect(payload.authKind).toBe('apikey');
    expect(payload.engineBacked).toBe(false);
    expect(payload).toHaveProperty('capability', 'video.avatar');
  });

  it('auth_kind=oauth → authKind="oauth"', async () => {
    catState.authKind = 'oauth';
    const payload = await driveCredentialMissing('some-oauth-provider');
    expect(payload.authKind).toBe('oauth');
    expect(payload.engineBacked).toBe(false);
  });

  it('auth_kind=none → authKind="none" + engineBacked=true (engine-backed)', async () => {
    catState.authKind = 'none';
    const payload = await driveCredentialMissing('imagegen2');
    expect(payload.authKind).toBe('none');
    expect(payload.engineBacked).toBe(true);
  });

  it('SOP engineBacked=true überschreibt → authKind="none"', async () => {
    catState.authKind = 'api_key'; // Katalog sagt api_key …
    catState.sop = { engineBacked: true, accountSignupUrl: null, credentialFieldHint: null };
    const payload = await driveCredentialMissing('imagegen2');
    expect(payload.authKind).toBe('none'); // … SOP-Marker gewinnt.
    expect(payload.engineBacked).toBe(true);
  });

  it('kein Katalog-Eintrag → Default authKind="apikey" (fail-open sicher)', async () => {
    catState.authKind = null;
    catState.docsUrl = null;
    const payload = await driveCredentialMissing('unknown-provider');
    expect(payload.authKind).toBe('apikey');
  });

  it('SOP-Hints (signupUrl, credentialFieldHint, docsUrl) fließen in Payload', async () => {
    catState.authKind = 'api_key';
    catState.docsUrl = 'https://docs.example.com';
    catState.sop = {
      engineBacked: false,
      accountSignupUrl: 'https://app.example.com/login',
      credentialFieldHint: 'Füge deinen API-Key ein.',
    };
    const payload = await driveCredentialMissing('higgsfield');
    expect(payload.signupUrl).toBe('https://app.example.com/login');
    expect(payload.credentialFieldHint).toBe('Füge deinen API-Key ein.');
    expect(payload.docsUrl).toBe('https://docs.example.com');
  });

  it('SECURITY: kein secret/token-Feld im credential-request-Payload', async () => {
    catState.authKind = 'oauth';
    const payload = await driveCredentialMissing('heygen-avatar');
    const FORBIDDEN = ['secret', 'token', 'api_key', 'apiKey', 'password', 'accessToken'];
    for (const k of FORBIDDEN) {
      expect(payload).not.toHaveProperty(k);
    }
  });
});
