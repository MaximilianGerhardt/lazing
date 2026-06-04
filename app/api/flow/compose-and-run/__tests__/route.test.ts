/**
 * Tests für POST /api/flow/compose-and-run — Stream-B2-Verdrahtung (2026-05-27).
 *
 * Fokus dieser Datei (additiv zu lib/flow/compose-and-run.test.ts, das die
 * Kern-Funktion testet): der ROUTE-CONTRACT für die Stil-Wahl —
 *   (a) Auth-Gate unverändert: kein Subject → 401; Nicht-Member → 403.
 *   (b) needs-style-choice wird 1:1 durchgereicht (status + flowId + die
 *       quickchoice-Prompts inkl. step.idx — der stabile styleChoices-Schlüssel).
 *   (c) Re-POST MIT styleChoices: der Body-Param wird validiert + 1:1 an
 *       composeAndRun gereicht → running / needs-coupling kommen durch.
 *   (d) styleChoices-Validierung: fremde/leere Einträge werden still verworfen
 *       (fail-soft), KEIN Request-Reject.
 *
 * Mock-Architektur: composeAndRun + die Auth/DB/Engine-Abhängigkeiten gemockt —
 * wir testen NUR die Route (kein echtes Compose, kein LLM, keine DB).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     app/api/flow/compose-and-run/__tests__/route.test.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks — KEIN Zugriff auf outer variables in factory (vi.mock wird gehoisted).
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('@/lib/security/subject-server', () => ({
  currentUserIdResolved: vi.fn().mockReturnValue('user-1'),
}));

vi.mock('@/lib/security/permissions', () => ({
  getEffectiveWorkspaceRole: vi.fn().mockReturnValue('member'),
  canEditWorkspaceContent: vi.fn().mockReturnValue(true),
}));

vi.mock('@/db/client', () => ({
  getDb: vi.fn(() => ({ $raw: {} })),
}));

vi.mock('@/lib/llm/engines/selector', () => ({
  detectEngines: vi.fn().mockResolvedValue({}),
  pickEngine: vi.fn().mockReturnValue({
    chat: vi.fn().mockResolvedValue({ text: '[]' }),
  }),
}));

vi.mock('@/lib/flow/compose-and-run', () => ({
  composeAndRun: vi.fn(),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Imports (nach Mock-Setup)
// ──────────────────────────────────────────────────────────────────────────────

import { POST } from '../route';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent } from '@/lib/security/permissions';
import { composeAndRun } from '@/lib/flow/compose-and-run';

const mockCurrentUserIdResolved = vi.mocked(currentUserIdResolved);
const mockCanEditWorkspaceContent = vi.mocked(canEditWorkspaceContent);
const mockComposeAndRun = vi.mocked(composeAndRun);

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/flow/compose-and-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  // Defaults zurücksetzen (clearAllMocks löscht Implementierungen NICHT, aber
  // Rückgabewerte schon → neu setzen).
  mockCurrentUserIdResolved.mockReturnValue('user-1');
  mockCanEditWorkspaceContent.mockReturnValue(true);
});

describe('POST /api/flow/compose-and-run — Auth-Gate (unverändert)', () => {
  it('kein Subject → 401', async () => {
    mockCurrentUserIdResolved.mockReturnValue(null);
    const res = await POST(makeReq({ intent: 'x', workspaceId: 'ws-1' }));
    expect(res.status).toBe(401);
    expect(mockComposeAndRun).not.toHaveBeenCalled();
  });

  it('Nicht-Member (canEdit=false) → 403', async () => {
    mockCanEditWorkspaceContent.mockReturnValue(false);
    const res = await POST(makeReq({ intent: 'x', workspaceId: 'ws-1' }));
    expect(res.status).toBe(403);
    expect(mockComposeAndRun).not.toHaveBeenCalled();
  });

  it('leerer Intent → 400', async () => {
    const res = await POST(makeReq({ intent: '   ', workspaceId: 'ws-1' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/flow/compose-and-run — needs-style-choice durchgereicht', () => {
  it('gibt status + flowId + die quickchoice-Prompts inkl. step.idx zurück', async () => {
    const styleChoicePrompts = [
      {
        step: {
          stepId: 'FSTEP-abc',
          idx: 1,
          stepTitle: 'Hero-Video für die Startseite',
          skill: 'tool:video',
          kind: 'video',
        },
        payload: {
          variant: 'quickchoice',
          stepId: 'FSTEP-abc',
          stepTitle: 'Hero-Video für die Startseite',
          stepKind: 'video',
          flowId: 'FLOW-1',
          options: [
            { id: 'video-higgsfield', label: 'Eigenes Video (Higgsfield)', sublabel: '…', primary: true },
            { id: 'video-procedural', label: 'Prozedural generiert', sublabel: '…' },
          ],
        },
      },
    ];
    mockComposeAndRun.mockResolvedValue({
      status: 'needs-style-choice',
      flowId: 'FLOW-1',
      styleChoices: styleChoicePrompts,
    } as never);

    const res = await POST(makeReq({ intent: 'Landingpage mit Hero-Video', workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      flowId: string;
      styleChoices: typeof styleChoicePrompts;
    };
    expect(json.status).toBe('needs-style-choice');
    expect(json.flowId).toBe('FLOW-1');
    expect(json.styleChoices).toHaveLength(1);
    // Der stabile Re-Compose-Schlüssel (step.idx) muss durchkommen.
    expect(json.styleChoices[0].step.idx).toBe(1);
    expect(json.styleChoices[0].payload.options.map((o) => o.id)).toContain(
      'video-higgsfield',
    );

    // composeAndRun OHNE styleChoices aufgerufen (Erst-Compose).
    expect(mockComposeAndRun).toHaveBeenCalledTimes(1);
    const arg = mockComposeAndRun.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(arg.intent).toBe('Landingpage mit Hero-Video');
    expect(arg.styleChoices).toBeUndefined();
  });
});

describe('POST /api/flow/compose-and-run — Track-D Repro-Persistenz (2026-05-29)', () => {
  it('Response trägt reqId UND flowRunId (Persistenz-Trail) bei status=running', async () => {
    mockComposeAndRun.mockResolvedValue({
      reqId: 'req-route-ok',
      flowRunId: 'FRUN-route-ok',
      status: 'running',
      flowId: 'FLOW-1',
      runId: 'RUN-1',
      workstreamId: 'WS-1',
    } as never);

    const res = await POST(makeReq({ intent: 'x', workspaceId: 'ws-1' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      reqId: string;
      flowRunId: string;
      status: string;
    };
    expect(json.reqId).toMatch(/^req-/);
    expect(json.flowRunId).toBe('FRUN-route-ok');
    expect(json.status).toBe('running');
  });

  it('401-Antwort trägt reqId für Korrelation', async () => {
    mockCurrentUserIdResolved.mockReturnValue(null);
    const res = await POST(makeReq({ intent: 'x', workspaceId: 'ws-1' }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string; reqId: string };
    expect(json.error).toBe('auth-required');
    expect(json.reqId).toMatch(/^req-/);
  });

  it('400-Antwort (invalid_intent) trägt reqId', async () => {
    const res = await POST(makeReq({ intent: '   ', workspaceId: 'ws-1' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; reqId: string };
    expect(json.error).toBe('invalid_intent');
    expect(json.reqId).toMatch(/^req-/);
  });

  it('500-Antwort bei unerwartetem Error trägt reqId + message', async () => {
    mockComposeAndRun.mockRejectedValue(new Error('boom'));
    const res = await POST(makeReq({ intent: 'x', workspaceId: 'ws-1' }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as {
      error: string;
      message: string;
      reqId: string;
    };
    expect(json.error).toBe('compose_and_run_failed');
    expect(json.message).toBe('boom');
    expect(json.reqId).toMatch(/^req-/);
  });

  it('reqId der Route wird an composeAndRun durchgereicht', async () => {
    mockComposeAndRun.mockResolvedValue({
      reqId: 'will-be-overwritten-by-arg',
      flowRunId: null,
      status: 'needs-coupling',
      flowId: 'FLOW-1',
      missingTools: [],
    } as never);
    await POST(makeReq({ intent: 'x', workspaceId: 'ws-1' }));
    const arg = mockComposeAndRun.mock.calls[0]![1] as unknown as Record<
      string,
      unknown
    >;
    expect(typeof arg.reqId).toBe('string');
    expect(String(arg.reqId)).toMatch(/^req-/);
  });
});

describe('POST /api/flow/compose-and-run — Re-POST mit styleChoices', () => {
  it('reicht validierte styleChoices an composeAndRun und gibt running zurück', async () => {
    mockComposeAndRun.mockResolvedValue({
      status: 'running',
      flowId: 'FLOW-1',
      runId: 'RUN-1',
      workstreamId: 'WS-1',
    } as never);

    const res = await POST(
      makeReq({
        intent: 'Landingpage mit Hero-Video',
        workspaceId: 'ws-1',
        styleChoices: { '1': 'video-procedural' },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; workstreamId: string };
    expect(json.status).toBe('running');
    expect(json.workstreamId).toBe('WS-1');

    const arg = mockComposeAndRun.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(arg.styleChoices).toEqual({ '1': 'video-procedural' });
  });

  it('connector-Stil → needs-coupling kommt durch (provider higgsfield)', async () => {
    mockComposeAndRun.mockResolvedValue({
      status: 'needs-coupling',
      flowId: 'FLOW-1',
      missingTools: [
        {
          stepId: 'FSTEP-abc',
          stepTitle: 'Hero-Video',
          skill: 'tool:video',
          provider: 'higgsfield',
          neededCapabilities: ['video.motion'],
          reason: 'credential',
        },
      ],
    } as never);

    const res = await POST(
      makeReq({
        intent: 'Landingpage mit Hero-Video',
        workspaceId: 'ws-1',
        styleChoices: { '1': 'video-higgsfield' },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      missingTools: Array<{ provider: string }>;
    };
    expect(json.status).toBe('needs-coupling');
    expect(json.missingTools[0].provider).toBe('higgsfield');
  });

  it('verwirft leere/fremde styleChoices-Einträge still (fail-soft) → undefined an composeAndRun', async () => {
    mockComposeAndRun.mockResolvedValue({
      status: 'needs-style-choice',
      flowId: 'FLOW-1',
      styleChoices: [],
    } as never);

    await POST(
      makeReq({
        intent: 'x',
        workspaceId: 'ws-1',
        // alles unbrauchbar: leerer Wert, leerer Key, nicht-string.
        styleChoices: { '1': '', '': 'video-procedural', '2': 42 },
      }),
    );
    const arg = mockComposeAndRun.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(arg.styleChoices).toBeUndefined();
  });

  it('styleChoices als Array (kein Objekt) → ignoriert (undefined)', async () => {
    mockComposeAndRun.mockResolvedValue({
      status: 'needs-style-choice',
      flowId: 'FLOW-1',
      styleChoices: [],
    } as never);
    await POST(
      makeReq({ intent: 'x', workspaceId: 'ws-1', styleChoices: ['nope'] }),
    );
    const arg = mockComposeAndRun.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(arg.styleChoices).toBeUndefined();
  });
});

describe('POST /api/flow/compose-and-run — Engine-Timeout-Headroom (Showstopper-Fix 2026-05-29)', () => {
  // ROOT-CAUSE-REGRESSION: die claude-cli-Engine hat DEFAULT_TIMEOUT_MS=60_000.
  // Ein realer Website-Decompose über die MAX-Plan-Keychain-Route braucht
  // empirisch 38–57s PRO Call und der Recursive-Decompose kettet mehrere Calls
  // → ohne explizites timeoutMs kippte er in `claude-cli timeout after 60000ms`
  // → 500 → flow_runs blieb auf `pending` (22/22 Runs nie `done`). Der Fix gibt
  // dem Compose-Call explizit Headroom (> 60s). Dieser Test bindet das fest:
  // der von der Route an composeAndRun gereichte `callEngine` MUSS engine.chat
  // mit einem timeoutMs deutlich über dem 60s-Default aufrufen.
  it('callEngine ruft engine.chat mit timeoutMs > 60_000 (Default) auf', async () => {
    const { pickEngine } = await import('@/lib/llm/engines/selector');
    const chatMock = vi.fn().mockResolvedValue({ text: '[]' });
    vi.mocked(pickEngine).mockReturnValue({
      id: 'claude-cli',
      chat: chatMock,
    } as never);

    mockComposeAndRun.mockResolvedValue({
      status: 'needs-coupling',
      flowId: 'FLOW-1',
      flowRunId: null,
      missingTools: [],
    } as never);

    await POST(
      makeReq({ intent: 'Ich möchte eine Website erstellen', workspaceId: 'ws-1' }),
    );

    // Die Route reicht callEngine als Input an composeAndRun → von dort greifen.
    const arg = mockComposeAndRun.mock.calls[0]![1] as unknown as {
      callEngine: (prompt: string) => Promise<string>;
    };
    expect(typeof arg.callEngine).toBe('function');

    // callEngine ausführen → muss engine.chat mit timeoutMs-Headroom aufrufen.
    await arg.callEngine('decompose this');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const chatArgs = chatMock.mock.calls[0]![0] as { timeoutMs?: number };
    expect(chatArgs.timeoutMs).toBeGreaterThan(60_000);
  });
});
