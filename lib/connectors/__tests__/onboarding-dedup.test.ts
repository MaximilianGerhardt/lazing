/**
 * lib/connectors/__tests__/onboarding-dedup.test.ts
 *
 * Regression-Test für den Onboarding-Loop-Dedup-Bug (2026-05-30):
 *   Vorher: jeder Chat-Prompt mit missing='profile' für denselben Provider
 *   spawnte einen NEUEN „Connector-Onboarding: <provider>"-Workstream → 3+
 *   parallele Runs.
 *   Fix: triggerOnboardingSop dedupt via findActiveOnboardingWorkstreamId —
 *   existiert ein aktiver/pausierter Onboarding-Workstream für Provider+
 *   Workspace, wird KEIN neuer gespawnt.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/connectors/__tests__/onboarding-dedup.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { WORKSPACE_ID, PROVIDER, SOP_ID, WS_ID, PLAN_ID, EXISTING_WS_ID } =
  vi.hoisted(() => ({
    WORKSPACE_ID: 'ws-dedup-001',
    PROVIDER: 'heygen',
    SOP_ID: 'SOP-CONNECTOR-ONBOARDING-01',
    WS_ID: 'WS-onboarding-new',
    PLAN_ID: 'PLN-onboarding-001',
    EXISTING_WS_ID: 'WS-onboarding-EXISTING',
  }));

// ── Controllable SELECT-row für $raw.prepare().get() ─────────────────────────
// dedupRow steuert, was die `SELECT id FROM workstreams ...`-Query zurückgibt.
// null → kein bestehender Run (Spawn erlaubt). { id } → Dedup greift.
const dedupState = vi.hoisted(() => ({ row: null as { id: string } | null }));

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockListSops = vi.fn();
const mockGetSop = vi.fn();
vi.mock('@/lib/sop/registry', () => ({
  listSops: (...a: unknown[]) => mockListSops(...a),
  getSop: (...a: unknown[]) => mockGetSop(...a),
}));

const mockExpandSopToPlanNodes = vi.fn();
vi.mock('@/lib/sop/executor', () => ({
  expandSopToPlanNodes: (...a: unknown[]) => mockExpandSopToPlanNodes(...a),
}));

const mockCreateWorkstream = vi.fn();
vi.mock('@/lib/workstreams/service', () => ({
  createWorkstream: (...a: unknown[]) => mockCreateWorkstream(...a),
  getWorkstream: vi.fn(),
  updateWorkstream: vi.fn(),
}));

const mockInsertProposedPlan = vi.fn();
vi.mock('@/lib/workstreams/plan-repo', () => ({
  insertProposedPlan: (...a: unknown[]) => mockInsertProposedPlan(...a),
  listRootPlanSteps: vi.fn().mockReturnValue([]),
  setPlanStepStatus: vi.fn(),
}));

const mockExecutePlan = vi.fn();
vi.mock('@/lib/workstreams/plan-executor', () => ({
  executePlan: (...a: unknown[]) => mockExecutePlan(...a),
}));

const mockWriteDecision = vi.fn();
vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: (...a: unknown[]) => mockWriteDecision(...a),
  writeEvidence: vi.fn(),
}));

const mockEmitOrUpdateCard = vi.fn(async (_a: unknown) => ({
  event: { id: 'evt-test' },
  mode: 'inserted' as const,
}));
vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: (a: unknown) => mockEmitOrUpdateCard(a),
}));

// DB client — $raw.prepare().get() liefert dedupState.row für die SELECT-Query.
const mockRawTransaction = vi.fn((fn: () => void) => () => fn());
vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: vi.fn(() => ({
        // Beide Aufrufer (hasCredential COUNT + dedup SELECT id) teilen sich
        // diesen get(); dedup liest row?.id, COUNT liest row?.n. Wir liefern
        // dedupState.row (hat id) ODER {n:0}. Für den COUNT-Pfad ist id egal
        // (detect ist gestubbt → kein COUNT-Aufruf im Test-Pfad).
        get: vi.fn(() => dedupState.row ?? { n: 0 }),
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

vi.mock('@/lib/ulid', () => ({ ulid: () => 'mock-ulid' }));

vi.mock('@/lib/connectors/detect', () => ({
  detectConnector: vi.fn(() => ({
    provider: null,
    missing: 'no-connector',
    neededCapabilities: [],
    confidence: 0,
    rationale: 'test',
  })),
}));

vi.mock('@/lib/connectors/invoke', () => ({ previewCall: vi.fn() }));
vi.mock('@/db/schema/memberships', () => ({
  workspaceMemberships: { userId: 'userId', workspaceId: 'workspaceId' },
}));
// catalog + onboarding-sop werden von deriveProviderAuthProfile genutzt — hier
// nur für den credential-Pfad relevant, im profile-Pfad ungenutzt. Stub safe.
vi.mock('@/lib/connectors/catalog', () => ({
  getConnectorProfile: vi.fn(() => null),
}));
vi.mock('@/lib/connectors/onboarding-sop', () => ({
  getOnboardingSop: vi.fn(() => null),
}));

const NOW = 1_748_200_000_000;

function makeSopRow(id = SOP_ID, name = 'connector-onboarding') {
  return {
    id, name, description: 'Onboard', workspaceId: null, version: 1,
    builtIn: false, archivedAt: null, contentHash: `bootstrap:${id}`, createdAt: NOW,
  };
}
function makeSopWithSteps(id = SOP_ID) {
  return {
    ...makeSopRow(id),
    steps: [{
      id: 'SOPS-01', sopId: id, stepIndex: 0, title: 'Research',
      stepPromptTemplate: 'Discover {{goal_prompt}}.', subagentRole: 'researcher',
      requiredSkillsJson: null, mcpToolAllowlistJson: null, optional: false,
    }],
  };
}
function makePlanNodes(planId = PLAN_ID) {
  return [{
    id: 'node-001',
    step: { id: 'STEP-001', index: 1, title: 'Research', rationale: 'Discover', subagentRole: undefined },
    plan: {
      id: planId, originalIntent: 'connector-onboarding', estimatedComplexity: 'M' as const,
      proposedAt: NOW,
      steps: [{ id: 'STEP-001', index: 1, title: 'Research', rationale: 'Discover', subagentRole: undefined }],
    },
    depth: 0, cascadeMode: 'per-level' as const, awaitingApproval: false, children: new Map(),
  }];
}

const { maybeAutoConnect } = await import('../auto-connect');
const BASE_CTX = { workspaceId: WORKSPACE_ID, userId: 'user-001' };

async function driveProfileMissing(provider = PROVIDER): Promise<void> {
  const { detectConnector } = await import('@/lib/connectors/detect');
  (detectConnector as ReturnType<typeof vi.fn>).mockReturnValueOnce({
    provider, missing: 'profile', neededCapabilities: ['render_video'],
    confidence: 0.9, rationale: `${provider} mentioned`,
  });
  await maybeAutoConnect(`Erstelle ein ${provider} Video`, BASE_CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  dedupState.row = null;
  mockRawTransaction.mockImplementation((fn: () => void) => () => fn());
  mockCreateWorkstream.mockResolvedValue({
    id: WS_ID, name: `Connector-Onboarding: ${PROVIDER}`,
    description: `Connector-Profil für '${PROVIDER}' anlegen`,
    workspaceId: WORKSPACE_ID, status: 'active',
  });
  mockExecutePlan.mockResolvedValue(undefined);
  mockWriteDecision.mockReturnValue('dec-001');
  mockListSops.mockReturnValue([makeSopRow()]);
  mockGetSop.mockReturnValue(makeSopWithSteps());
  mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());
});

afterEach(() => vi.clearAllMocks());

describe('Onboarding-Loop-Dedup (Bug-Fix 2026-05-30)', () => {
  it('kein bestehender Run → spawnt EINEN neuen Onboarding-Workstream', async () => {
    dedupState.row = null; // kein aktiver Run
    await driveProfileMissing();

    expect(mockCreateWorkstream).toHaveBeenCalledOnce();
    expect(mockInsertProposedPlan).toHaveBeenCalled();
    expect(mockExecutePlan).toHaveBeenCalledOnce();
  });

  it('aktiver Run existiert → DEDUP: KEIN neuer Workstream, kein executePlan', async () => {
    dedupState.row = { id: EXISTING_WS_ID }; // aktiver Onboarding-Run vorhanden
    await driveProfileMissing();

    // KEIN Spawn.
    expect(mockCreateWorkstream).not.toHaveBeenCalled();
    expect(mockInsertProposedPlan).not.toHaveBeenCalled();
    expect(mockExecutePlan).not.toHaveBeenCalled();

    // Dedup-Decision (N8) referenziert den bestehenden Workstream.
    expect(mockWriteDecision).toHaveBeenCalledOnce();
    const dec = mockWriteDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(dec.workstreamId).toBe(EXISTING_WS_ID);
    expect(String(dec.rationale)).toContain('DEDUP');

    // Status-Card zeigt den laufenden Run (deduped:true), kein Secret.
    const card = mockEmitOrUpdateCard.mock.calls.find((c) => {
      const a = c[0] as { coords: { surfaceKind: string } };
      return a.coords.surfaceKind === 'onboarding-progress';
    });
    expect(card).toBeDefined();
    const content = (card![0] as { content: string }).content;
    expect(content).toContain(EXISTING_WS_ID);
    expect(content).toContain('deduped');
    expect(content).not.toContain('"secret"');
  });

  it('drei aufeinanderfolgende Prompts → nur EIN Spawn (zweiter+dritter dedupt)', async () => {
    // 1. Prompt: kein Run → Spawn.
    dedupState.row = null;
    await driveProfileMissing();
    expect(mockCreateWorkstream).toHaveBeenCalledOnce();

    // Ab jetzt existiert ein aktiver Run → folgende Prompts dedupen.
    dedupState.row = { id: EXISTING_WS_ID };
    await driveProfileMissing();
    await driveProfileMissing();

    // Trotz drei Prompts: nur EIN createWorkstream insgesamt.
    expect(mockCreateWorkstream).toHaveBeenCalledOnce();
  });
});
