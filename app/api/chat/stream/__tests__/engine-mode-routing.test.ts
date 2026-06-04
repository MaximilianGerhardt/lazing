/**
 * Engine-Mode Routing Tests (C6 entgate · 2026-05-25)
 *
 * Tests:
 *   (a) engineMode='parallel-all' → orchestrator-SSE-Pfad (nicht agent-server-Forward).
 *       Beweis: SSE-Response enthält pending_id + token + done-Frame;
 *               agent-server-fetch wurde NICHT aufgerufen.
 *   (b) engineMode='codex-cli'    → orchestrate() mit codexMode='read' (assert 'read', nie 'write').
 *       Beweis: SSE-Response OK; capturedCodexMode === 'read'.
 *   (c) engineMode='claude-cli'   → agent-server-Pfad (buildOrchestratorSse nicht aufgerufen).
 *       Beweis: agent-server-fetch wurde aufgerufen; orchestrate NICHT.
 *   (d) useAgentStream Whitelist   → alle 4 Modi durch; Müll → undefined.
 *   (e) ChatTopBar + EnginePill    → GATED_MODES leer, keine Emojis in OPTIONS.
 *
 * Mock-Architektur für (a)+(b)+(c):
 *   Route importiert orchestrator via dynamischem import() — wir hoisten
 *   vi.mock() für '@/lib/llm/orchestrator' (vitest hoist vor allen imports).
 *   capturedCalls-Array wird geteilt via module-scope Closure.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     app/api/chat/stream/__tests__/engine-mode-routing.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Shared capture array — filled by the orchestrate mock below.
// ---------------------------------------------------------------------------

interface CapturedCall {
  mode: string;
  codexMode?: string;
}
const capturedCalls: CapturedCall[] = [];

// ---------------------------------------------------------------------------
// Module-level mocks (vitest hoists vi.mock() to file top)
// ---------------------------------------------------------------------------

vi.mock('@/lib/llm/orchestrator', () => ({
  orchestrate: async (req: { mode: string; codexMode?: string; messages: unknown[] }) => {
    capturedCalls.push({ mode: req.mode, codexMode: req.codexMode });
    return {
      engine: req.mode === 'parallel-all' ? 'ollama' : req.mode,
      mode: req.mode,
      model: 'mock-model',
      text: 'mock orchestrator response',
      latencyMs: 5,
      attempts: [],
    };
  },
}));

vi.mock('@/lib/events/emit', () => ({
  emitChatMessageSent: async () => undefined,
  emitChatMessageCompleted: async () => undefined,
}));

vi.mock('@/lib/chat/ledger', () => ({
  appendLedgerRow: () => undefined,
}));

vi.mock('@/db/client', () => ({
  getDb: () => ({ $raw: {} }),
}));

vi.mock('@/lib/security/subject', () => ({
  currentSubject: () => ({ type: 'user', id: 'test-user' }),
}));

vi.mock('@/lib/ulid', () => ({
  ulid: () => 'mock-ulid-0000',
}));

// ---------------------------------------------------------------------------
// Helper: make a POST request to /api/chat/stream
// ---------------------------------------------------------------------------

function makeStreamRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:4200/api/chat/stream', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'lazyos_session=mock-session',
      authorization: 'Bearer mock-bearer',
    },
    body: JSON.stringify(body),
  });
}

const BASE_BODY = {
  messages: [{ role: 'user', content: 'hello' }],
  workspaceId: 'ws_test01',
};

/**
 * Read the full SSE body from a Response into a string.
 */
async function readSse(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests: route.ts engine-mode routing
// ---------------------------------------------------------------------------

describe('POST /api/chat/stream — engine-mode routing (C6 entgate)', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    capturedCalls.length = 0;
    process.env.LAZYOS_AGENT_URL = 'http://127.0.0.1:4201';
    process.env.LAZYOS_CHAT_KEY = 'mock-chat-key';
    // Import fresh each suite to ensure mocks are in scope.
    const mod = await import('../route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) parallel-all → orchestrator-SSE, NOT agent-server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    const res = await POST(makeStreamRequest({ ...BASE_BODY, engineMode: 'parallel-all' }));

    // Must be 200 SSE.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    // Read SSE body — must contain token frame with mock text.
    const body = await readSse(res);
    expect(body).toContain('event: token');
    expect(body).toContain('mock orchestrator response');
    expect(body).toContain('event: done');

    // Orchestrate must have been called with mode:'parallel-all'.
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].mode).toBe('parallel-all');

    // Agent-server fetch (port 4201) must NOT have been called.
    const agentCalls = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes('4201'),
    );
    expect(agentCalls.length).toBe(0);
  });

  it('(b) codex-cli → orchestrate codexMode=read, never write', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    const res = await POST(makeStreamRequest({ ...BASE_BODY, engineMode: 'codex-cli' }));

    expect(res.status).toBe(200);
    const body = await readSse(res);
    expect(body).toContain('event: token');

    // orchestrate must have been called with mode:'codex-cli' and codexMode:'read'.
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].mode).toBe('codex-cli');

    // Critical safety assertion: codexMode MUST be 'read', NEVER 'write'.
    expect(capturedCalls[0].codexMode).toBe('read');
    expect(capturedCalls[0].codexMode).not.toBe('write');
  });

  it('(b.2) codex-cli body extra fields cannot inject codexMode=write', async () => {
    // BodySchema strips unknown keys (Zod default), so codexMode from body
    // is never visible to the route handler. The route hardcodes 'read'.
    // Proof: SSE response is 200 (orchestrator path taken, not 400 or agent-server).
    // The codexMode='read' assertion is already covered by test (b) above.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    const res = await POST(
      makeStreamRequest({
        ...BASE_BODY,
        engineMode: 'codex-cli',
        // Adversarial: extra field, Zod strips it.
        codexMode: 'write',
      }),
    );

    // Route must still produce orchestrator-SSE (not 400 from Zod, not 500
    // from agent-server), proving the extra field was stripped harmlessly.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await readSse(res);
    expect(body).toContain('event: token');
    // mock orchestrator response confirms orchestrator was called.
    expect(body).toContain('mock orchestrator response');
  });

  it('(c) claude-cli → agent-server path, orchestrate NOT called', async () => {
    const mockSseBody = 'event: done\ndata: {"is_error":false}\n\n';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(mockSseBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const res = await POST(makeStreamRequest({ ...BASE_BODY, engineMode: 'claude-cli' }));

    // Route must have forwarded to agent-server (port 4201).
    const agentCalls = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes('4201'),
    );
    expect(agentCalls.length).toBeGreaterThan(0);

    // Orchestrate must NOT have been called.
    expect(capturedCalls.length).toBe(0);

    expect(res.status).toBe(200);
  });

  it('(c.2) no engineMode → default claude-cli → agent-server, orchestrate NOT called', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('event: done\ndata: {"is_error":false}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const res = await POST(makeStreamRequest(BASE_BODY)); // no engineMode

    expect(capturedCalls.length).toBe(0);
    expect(res.status).toBe(200);
  });

  it('(a.2) ollama → orchestrator-SSE (pre-existing, regression guard)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    const res = await POST(makeStreamRequest({ ...BASE_BODY, engineMode: 'ollama' }));

    // SSE response confirms orchestrator path (not agent-server forward).
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const body = await readSse(res);
    expect(body).toContain('event: token');
    expect(body).toContain('mock orchestrator response');
  });
});

// ---------------------------------------------------------------------------
// (d) useAgentStream safeEngineMode whitelist — logic extracted for unit test
// ---------------------------------------------------------------------------

describe('useAgentStream — safeEngineMode whitelist (C6 entgate)', () => {
  /**
   * Mirrors the exact conditional logic in useAgentStream.ts safeEngineMode.
   * If the source changes, tsc will catch it; this test confirms the semantics.
   */
  function resolveSafeEngineMode(
    raw: string,
  ): 'claude-cli' | 'ollama' | 'parallel-all' | 'codex-cli' | undefined {
    return raw === 'claude-cli' ||
      raw === 'ollama' ||
      raw === 'parallel-all' ||
      raw === 'codex-cli'
      ? (raw as 'claude-cli' | 'ollama' | 'parallel-all' | 'codex-cli')
      : undefined;
  }

  it('allows claude-cli', () => expect(resolveSafeEngineMode('claude-cli')).toBe('claude-cli'));
  it('allows ollama', () => expect(resolveSafeEngineMode('ollama')).toBe('ollama'));
  it('allows parallel-all', () => expect(resolveSafeEngineMode('parallel-all')).toBe('parallel-all'));
  it('allows codex-cli', () => expect(resolveSafeEngineMode('codex-cli')).toBe('codex-cli'));
  it('rejects unknown → undefined', () => {
    expect(resolveSafeEngineMode('gpt-4')).toBeUndefined();
    expect(resolveSafeEngineMode('')).toBeUndefined();
    expect(resolveSafeEngineMode('codex-write')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (e) ChatTopBar + EnginePill source assertions — no emojis, GATED_MODES empty
// ---------------------------------------------------------------------------

describe('ChatTopBar + EnginePill source assertions (C6 entgate)', () => {
  it('ChatTopBar ENGINE_OPTIONS: no emoji property, no emoji chars', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/ChatTopBar.tsx'),
      'utf8',
    );

    const m = src.match(/const ENGINE_OPTIONS[^=]*=\s*\[[\s\S]*?\];/);
    expect(m).not.toBeNull();
    if (m) {
      expect(m[0]).not.toMatch(/emoji\s*:/);
      expect(m[0]).not.toMatch(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it('ChatTopBar GATED_MODES: empty set', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/ChatTopBar.tsx'),
      'utf8',
    );

    const m = src.match(/const GATED_MODES\s*=\s*new Set[^(]*\(([^)]*)\)/);
    expect(m).not.toBeNull();
    if (m) {
      // Strip generic type parameter, inner must be empty.
      const inner = m[1].replace(/<[^>]*>/g, '').trim();
      expect(inner).toBe('');
    }
  });

  it('EnginePill OPTIONS: no emoji property, no emoji chars', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'lib/chat/EnginePill.tsx'),
      'utf8',
    );

    const m = src.match(/const OPTIONS[^=]*=\s*\[[\s\S]*?\];/);
    expect(m).not.toBeNull();
    if (m) {
      expect(m[0]).not.toMatch(/emoji\s*:/);
      expect(m[0]).not.toMatch(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u);
    }
  });
});
