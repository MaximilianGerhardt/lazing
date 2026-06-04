/**
 * lib/connectors/__tests__/trigger-onboarding-sop.test.ts
 *
 * Tests for the real triggerOnboardingSop execution path inside
 * auto-connect.ts (P1-#5 — no more pure toast).
 *
 * Assertion focus (per task constraint (c)):
 *   - triggerOnboardingSop stößt echte SOP-Ausführung an (kein reiner Toast).
 *   - assert: Workstream erzeugt, Plan persistiert, executePlan aufgerufen.
 *   - Fallback: wenn kein SOP gefunden → Toast emittiert (kein Crash).
 *   - Security: kein secret-Feld im Card-Payload.
 *   - N1: goalPrompt enthält provider-Namen verbatim.
 *   - N8: writeDecision aufgerufen (Routing-Entscheidung dokumentiert).
 *   - N10: insertProposedPlan aufgerufen (contentHash via Plan-Repo).
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/connectors/__tests__/trigger-onboarding-sop.test.ts
 *
 * Mock strategy:
 *   - @/lib/sop/registry: getSop + listSops mocked.
 *   - @/lib/sop/executor: expandSopToPlanNodes mocked.
 *   - @/lib/workstreams/service: createWorkstream mocked.
 *   - @/lib/workstreams/plan-repo: insertProposedPlan mocked.
 *   - @/lib/workstreams/plan-executor: executePlan mocked.
 *   - @/lib/workstreams/trace-repo: writeDecision mocked.
 *   - @/lib/events/emit-or-update-card: emitOrUpdateCard spied.
 *   - @/db/client: getDb → $raw.transaction mocked.
 *   - @/lib/connectors/detect, invoke, @/db/schema/memberships: stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Shared constants (hoisted so mock factories can reference them)
// ──────────────────────────────────────────────────────────────────────────────

const { WORKSPACE_ID, PROVIDER, SOP_ID, WS_ID, PLAN_ID } = vi.hoisted(() => ({
  WORKSPACE_ID: 'ws-auto-connect-001',
  PROVIDER: 'heygen',
  SOP_ID: 'SOP-CONNECTOR-ONBOARDING-01',
  WS_ID: 'WS-onboarding-001',
  PLAN_ID: 'PLN-onboarding-001',
}));

// ──────────────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────────────

// SOP Registry
const mockListSops = vi.fn();
const mockGetSop = vi.fn();

vi.mock('@/lib/sop/registry', () => ({
  listSops: (...args: unknown[]) => mockListSops(...args),
  getSop: (...args: unknown[]) => mockGetSop(...args),
}));

// SOP Executor
const mockExpandSopToPlanNodes = vi.fn();

vi.mock('@/lib/sop/executor', () => ({
  expandSopToPlanNodes: (...args: unknown[]) => mockExpandSopToPlanNodes(...args),
}));

// Workstream service
const mockCreateWorkstream = vi.fn();

vi.mock('@/lib/workstreams/service', () => ({
  createWorkstream: (...args: unknown[]) => mockCreateWorkstream(...args),
  getWorkstream: vi.fn(),
  updateWorkstream: vi.fn(),
}));

// Plan repo
const mockInsertProposedPlan = vi.fn();

vi.mock('@/lib/workstreams/plan-repo', () => ({
  insertProposedPlan: (...args: unknown[]) => mockInsertProposedPlan(...args),
  listRootPlanSteps: vi.fn().mockReturnValue([]),
  setPlanStepStatus: vi.fn(),
}));

// Plan executor
const mockExecutePlan = vi.fn();

vi.mock('@/lib/workstreams/plan-executor', () => ({
  executePlan: (...args: unknown[]) => mockExecutePlan(...args),
}));

// Trace repo
const mockWriteDecision = vi.fn();

vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: (...args: unknown[]) => mockWriteDecision(...args),
  writeEvidence: vi.fn(),
}));

// emitOrUpdateCard
const mockEmitOrUpdateCard = vi.fn(async (_args: unknown) => ({
  event: { id: 'evt-test' },
  mode: 'inserted' as const,
}));

vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: (args: unknown) => mockEmitOrUpdateCard(args),
}));

// DB client — for $raw.transaction
const mockRawTransaction = vi.fn((fn: () => void) => () => fn());

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ n: 0 })),
      })),
      transaction: (fn: () => void) => mockRawTransaction(fn),
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ all: vi.fn(() => []) })),
        })),
      })),
    })),
  }),
}));

// ulid stub
vi.mock('@/lib/ulid', () => ({
  ulid: () => 'mock-ulid',
}));

// detectConnector — stub (not the focus of these tests)
vi.mock('@/lib/connectors/detect', () => ({
  detectConnector: vi.fn(() => ({
    provider: null,
    missing: 'no-connector',
    neededCapabilities: [],
    confidence: 0,
    rationale: 'test',
  })),
}));

// previewCall — stub
vi.mock('@/lib/connectors/invoke', () => ({
  previewCall: vi.fn(),
}));

// memberships schema — stub
vi.mock('@/db/schema/memberships', () => ({
  workspaceMemberships: { userId: 'userId', workspaceId: 'workspaceId' },
}));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const NOW = 1_748_200_000_000;

function makeSopRow(id = SOP_ID, name = 'connector-onboarding') {
  return {
    id,
    name,
    description: 'Onboard a connector profile',
    workspaceId: null,
    version: 1,
    builtIn: false,
    archivedAt: null,
    contentHash: `bootstrap:test:${id}`,
    createdAt: NOW - 10_000,
  };
}

function makeSopWithSteps(id = SOP_ID) {
  return {
    ...makeSopRow(id),
    steps: [
      {
        id: 'SOPS-OB-01',
        sopId: id,
        stepIndex: 0,
        title: 'Research: Discover connector capabilities',
        stepPromptTemplate: 'You are a Researcher. Discover connector profile for {{goal_prompt}}.',
        subagentRole: 'researcher',
        requiredSkillsJson: '["skill:researcher"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: 'SOPS-OB-02',
        sopId: id,
        stepIndex: 1,
        title: 'Scribe: Write connector profile',
        stepPromptTemplate: 'Write the connector profile for {{goal_prompt}}.',
        subagentRole: 'scribe',
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
    ],
  };
}

function makePlanNodes(planId = PLAN_ID) {
  return [
    {
      id: 'node-ob-001',
      step: { id: 'STEP-OB-001', index: 1, title: 'Research', rationale: 'Discover', subagentRole: undefined },
      plan: {
        id: planId,
        originalIntent: 'connector-onboarding',
        estimatedComplexity: 'M' as const,
        proposedAt: NOW,
        steps: [{ id: 'STEP-OB-001', index: 1, title: 'Research', rationale: 'Discover', subagentRole: undefined }],
      },
      depth: 0,
      cascadeMode: 'per-level' as const,
      awaitingApproval: false,
      children: new Map(),
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ──────────────────────────────────────────────────────────────────────────────

// Import SUT lazily AFTER mocks (top-level await in ESM, post-mock)
const { maybeAutoConnect } = await import('../auto-connect');

const BASE_CTX = { workspaceId: WORKSPACE_ID, userId: 'user-test-001' };

beforeEach(() => {
  vi.clearAllMocks();

  // Re-wire transaction mock (clearAllMocks wipes return values)
  mockRawTransaction.mockImplementation((fn: () => void) => () => fn());

  // Default: createWorkstream succeeds
  mockCreateWorkstream.mockResolvedValue({
    id: WS_ID,
    name: `Connector-Onboarding: ${PROVIDER}`,
    description: `Connector-Profil für '${PROVIDER}' anlegen`,
    workspaceId: WORKSPACE_ID,
    status: 'active',
  });

  // Default: executePlan resolves (non-destructive, fire-and-forget)
  mockExecutePlan.mockResolvedValue(undefined);

  // Default: writeDecision returns a decision ID
  mockWriteDecision.mockReturnValue('dec-ob-001');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('triggerOnboardingSop — echte SOP-Ausführung (kein reiner Toast)', () => {

  // (c-1): SOP gefunden → Workstream erzeugt, Plan persistiert, executePlan aufgerufen.
  it('(c-1) SOP gefunden → createWorkstream + insertProposedPlan + executePlan aufgerufen', async () => {
    // Arrange: listSops returns a matching SOP, getSop returns full SOP
    mockListSops.mockReturnValue([makeSopRow(SOP_ID, 'connector-onboarding')]);
    mockGetSop.mockReturnValue(makeSopWithSteps());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    // Act: trigger via maybeAutoConnect with missing='profile'
    const result = await maybeAutoConnect(
      `Heygen video API aufrufen`,
      BASE_CTX,
    );

    // The detectConnector mock returns no-connector by default → maybeAutoConnect
    // returns {acted:false}. We need to call triggerOnboardingSop directly.
    // Since triggerOnboardingSop is private, we drive it through maybeAutoConnect
    // by overriding the detectConnector mock inline.
    // Reset: mock detectConnector to return profile-missing for this test.
    void result; // suppress unused-variable warning — direct call below.

    // We need to override detectConnector at module level for this test.
    // Re-mock via vi.mocked (the module is already mocked globally above).
    const { detectConnector } = await import('@/lib/connectors/detect');
    (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: PROVIDER,
      missing: 'profile',
      neededCapabilities: ['render_video'],
      confidence: 0.9,
      rationale: 'heygen mentioned',
    });

    // Re-run after setting up the detection result
    const result2 = await maybeAutoConnect(`Erstelle ein Heygen Video`, BASE_CTX);

    expect(result2.acted).toBe(true);
    if (result2.acted) {
      expect(result2.action).toBe('onboarding');
      expect(result2.provider).toBe(PROVIDER);
    }

    // Core assertions: real SOP bridge was used
    expect(mockListSops).toHaveBeenCalled();
    expect(mockGetSop).toHaveBeenCalledWith(SOP_ID);
    expect(mockExpandSopToPlanNodes).toHaveBeenCalledOnce();

    // Workstream created (N9: scoped to workspaceId)
    expect(mockCreateWorkstream).toHaveBeenCalledOnce();
    const wsArgs = mockCreateWorkstream.mock.calls[0]![0] as Record<string, unknown>;
    expect(wsArgs.workspaceId).toBe(WORKSPACE_ID);
    // N1: goalPrompt contains provider name verbatim
    expect(String(wsArgs.description)).toContain(PROVIDER);

    // Plan persisted (N10: insertProposedPlan stamps contentHash)
    expect(mockInsertProposedPlan).toHaveBeenCalledOnce();

    // N8: writeDecision called with 'route' kind
    expect(mockWriteDecision).toHaveBeenCalledOnce();
    const decArgs = mockWriteDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(decArgs.decisionKind).toBe('route');
    expect(String(decArgs.rationale)).toContain(PROVIDER);
    expect(String(decArgs.rationale)).toContain(SOP_ID);

    // executePlan called (non-destructive, text-only)
    expect(mockExecutePlan).toHaveBeenCalledOnce();
    const execArgs = mockExecutePlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(execArgs.workstreamId).toBe(WS_ID);
    expect(execArgs.workspaceId).toBe(WORKSPACE_ID);
    // Phase-1: no mcpTools forwarded to executePlan
    expect(execArgs).not.toHaveProperty('mcpTools');

    // Card emitted with onboarding-progress surface (not just toast)
    expect(mockEmitOrUpdateCard).toHaveBeenCalled();
    const cardArgs = mockEmitOrUpdateCard.mock.calls.find(
      (call) => {
        const a = call[0] as { coords: { surfaceKind: string } };
        return a.coords.surfaceKind === 'onboarding-progress';
      },
    );
    expect(cardArgs).toBeDefined();
    if (cardArgs) {
      const cardContent = (cardArgs[0] as { content: string }).content;
      expect(cardContent).toContain(PROVIDER);
      expect(cardContent).toContain(WS_ID);
      expect(cardContent).toContain(PLAN_ID);
    }
  });

  // (c-2): Kein SOP gefunden → Fallback Toast, kein Crash, executePlan NICHT aufgerufen.
  it('(c-2) Kein SOP gefunden → Toast-Fallback, executePlan NICHT aufgerufen', async () => {
    // listSops returns SOPs that do NOT match connector-onboarding
    mockListSops.mockReturnValue([
      { id: 'SOP-OTHER', name: 'Bug-Fix Triage Pipeline', workspaceId: null },
    ]);

    const { detectConnector } = await import('@/lib/connectors/detect');
    (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: 'unknown-service',
      missing: 'profile',
      neededCapabilities: ['do_something'],
      confidence: 0.7,
      rationale: 'unknown-service mentioned',
    });

    const result = await maybeAutoConnect(`Unknown service aufrufen`, BASE_CTX);

    expect(result.acted).toBe(true);
    if (result.acted) expect(result.action).toBe('onboarding');

    // getSop should NOT have been called (no SOP found in list)
    expect(mockGetSop).not.toHaveBeenCalled();
    expect(mockExpandSopToPlanNodes).not.toHaveBeenCalled();
    expect(mockCreateWorkstream).not.toHaveBeenCalled();
    expect(mockInsertProposedPlan).not.toHaveBeenCalled();
    expect(mockExecutePlan).not.toHaveBeenCalled();
    expect(mockWriteDecision).not.toHaveBeenCalled();

    // Toast emitted
    expect(mockEmitOrUpdateCard).toHaveBeenCalledOnce();
    const cardArgs = mockEmitOrUpdateCard.mock.calls[0]![0] as {
      coords: { surfaceKind: string };
    };
    expect(cardArgs.coords.surfaceKind).toBe('toast');
  });

  // (c-3): SOP gefunden aber archived (getSop returns null) → Toast-Fallback.
  it('(c-3) SOP ID gefunden aber archiviert (getSop=null) → Toast, kein Crash', async () => {
    mockListSops.mockReturnValue([
      { id: SOP_ID, name: 'connector-onboarding', workspaceId: null },
    ]);
    // getSop returns null (archived)
    mockGetSop.mockReturnValue(null);

    const { detectConnector } = await import('@/lib/connectors/detect');
    (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: 'stripe',
      missing: 'profile',
      neededCapabilities: ['create_payment'],
      confidence: 0.85,
      rationale: 'stripe mentioned',
    });

    const result = await maybeAutoConnect(`Zahlung via Stripe`, BASE_CTX);
    expect(result.acted).toBe(true);

    expect(mockGetSop).toHaveBeenCalledWith(SOP_ID);
    expect(mockExpandSopToPlanNodes).not.toHaveBeenCalled();
    expect(mockExecutePlan).not.toHaveBeenCalled();

    // Toast (fallback for archived SOP)
    expect(mockEmitOrUpdateCard).toHaveBeenCalledOnce();
    const cardArgs = mockEmitOrUpdateCard.mock.calls[0]![0] as {
      coords: { surfaceKind: string };
    };
    expect(cardArgs.coords.surfaceKind).toBe('toast');
  });

  // (c-4): Security — no secret in card payload.
  it('(c-4) SECURITY: onboarding-progress-Card enthält kein secret-Feld', async () => {
    mockListSops.mockReturnValue([makeSopRow(SOP_ID, 'connector-onboarding')]);
    mockGetSop.mockReturnValue(makeSopWithSteps());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    const { detectConnector } = await import('@/lib/connectors/detect');
    (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: 'heygen',
      missing: 'profile',
      neededCapabilities: ['render_video'],
      confidence: 0.9,
      rationale: 'heygen',
    });

    await maybeAutoConnect(`Heygen video`, BASE_CTX);

    // Find the onboarding-progress card
    const cardCall = mockEmitOrUpdateCard.mock.calls.find((call) => {
      const a = call[0] as { coords: { surfaceKind: string } };
      return a.coords.surfaceKind === 'onboarding-progress';
    });

    if (cardCall) {
      const content = (cardCall[0] as { content: string }).content;
      // SECURITY: no secret/token/key fields in card content
      const FORBIDDEN = ['"secret"', '"token"', '"api_key"', '"apiKey"', '"password"', '"private_key"'];
      for (const forbidden of FORBIDDEN) {
        expect(content).not.toContain(forbidden);
      }
    }
  });

  // (c-5): executePlan throws → error swallowed, no propagation.
  it('(c-5) executePlan wirft → Fehler wird geschluckt, kein Crash in maybeAutoConnect', async () => {
    mockListSops.mockReturnValue([makeSopRow(SOP_ID, 'connector-onboarding')]);
    mockGetSop.mockReturnValue(makeSopWithSteps());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());
    // executePlan rejects
    mockExecutePlan.mockRejectedValue(new Error('engine timeout'));

    const { detectConnector } = await import('@/lib/connectors/detect');
    (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: 'heygen',
      missing: 'profile',
      neededCapabilities: ['render_video'],
      confidence: 0.9,
      rationale: 'heygen',
    });

    // Should NOT throw even though executePlan rejects
    await expect(maybeAutoConnect(`Heygen video`, BASE_CTX)).resolves.toMatchObject({
      acted: true,
      action: 'onboarding',
    });

    // Wait a tick for the fire-and-forget executePlan rejection to propagate
    await new Promise((r) => setTimeout(r, 10));

    // executePlan was called but rejection was caught internally
    expect(mockExecutePlan).toHaveBeenCalledOnce();
  });

  // (c-6): #4 — unsafe provider string → ID/workstream-name uses sanitized form;
  // goalPrompt and card display still contain the original provider value (N1).
  it('(c-6) #4 provider mit Sonderzeichen → safeProviderId in ID/Name, Originalwert in goalPrompt', async () => {
    const UNSAFE_PROVIDER = '../evil; rm -rf /';
    // Erwarteter sanitisierter Wert nach replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
    const SAFE_ID = '--evil--rm--rf--';

    mockListSops.mockReturnValue([makeSopRow(SOP_ID, 'connector-onboarding')]);
    mockGetSop.mockReturnValue(makeSopWithSteps());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    const { detectConnector } = await import('@/lib/connectors/detect');
    (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      provider: UNSAFE_PROVIDER,
      missing: 'profile',
      neededCapabilities: ['do_something'],
      confidence: 0.8,
      rationale: 'unsafe provider test',
    });

    await maybeAutoConnect(`Unsafe provider test`, BASE_CTX);

    // createWorkstream name must use the sanitized ID (not raw provider).
    expect(mockCreateWorkstream).toHaveBeenCalledOnce();
    const wsArgs = mockCreateWorkstream.mock.calls[0]![0] as Record<string, unknown>;
    expect(wsArgs.name).toContain(SAFE_ID);
    // name must NOT contain the raw unsafe characters
    expect(wsArgs.name).not.toContain(';');
    expect(wsArgs.name).not.toContain('/');
    expect(wsArgs.name).not.toContain('.');

    // N1: goalPrompt (in description) must contain the original provider verbatim.
    expect(String(wsArgs.description)).toContain(UNSAFE_PROVIDER);

    // The onboarding-progress card content must also contain the original provider (display).
    const progressCard = mockEmitOrUpdateCard.mock.calls.find((call) => {
      const a = call[0] as { coords: { surfaceKind: string } };
      return a.coords.surfaceKind === 'onboarding-progress';
    });
    if (progressCard) {
      const content = (progressCard[0] as { content: string }).content;
      expect(content).toContain(UNSAFE_PROVIDER);
    }
  });
});
