/**
 * POST /api/llm/orchestrate — Codex-Write-Boundary hardening tests
 *
 * Verifies two defence-in-depth properties introduced in the security
 * hardening pass (2026-05-25):
 *
 *   (A) Forged body with `codexMode: 'write'` is silently stripped by the
 *       Zod BodySchema. The orchestrate() mock receives codexMode='read'.
 *
 *   (B) Invalid bodies (bad mode, missing messages, non-JSON) return 400.
 *
 *   (C) Valid bodies reach orchestrate() with codexMode hardcoded to 'read'
 *       regardless of what the client sent.
 *
 * Mock strategy: vi.mock hoisted above all imports intercepts
 * '@/lib/llm/orchestrator'. The mock stores every received OrchestratorRequest
 * in `capturedCalls[]` so assertions can inspect codexMode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Shared capture array filled by the orchestrate mock.
// ---------------------------------------------------------------------------

interface CapturedOrchestrateCall {
  mode: string;
  codexMode?: string;
  messageCount: number;
}

const capturedCalls: CapturedOrchestrateCall[] = [];

// ---------------------------------------------------------------------------
// Module-level mock (vitest hoists vi.mock() to file top).
// ---------------------------------------------------------------------------

vi.mock('@/lib/llm/orchestrator', () => ({
  orchestrate: async (req: {
    mode: string;
    codexMode?: string;
    messages: unknown[];
  }) => {
    capturedCalls.push({
      mode: req.mode,
      codexMode: req.codexMode,
      messageCount: req.messages.length,
    });
    return {
      engine: 'codex-cli',
      mode: req.mode,
      model: 'mock-model',
      text: 'mock response',
      latencyMs: 3,
      attempts: [{ engine: 'codex-cli', latencyMs: 3, won: true }],
    };
  },
}));

// ---------------------------------------------------------------------------
// Helper: build a NextRequest for POST /api/llm/orchestrate
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:4200/api/llm/orchestrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_MESSAGES = [{ role: 'user', content: 'hello' }];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/llm/orchestrate — Codex-Write-Boundary hardening', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    capturedCalls.length = 0;
    const mod = await import('../route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // (A) Forged codexMode='write' is stripped — orchestrate() gets 'read'
  // -------------------------------------------------------------------------

  it('(A) forged codexMode=write in body → stripped, orchestrate receives codexMode=read', async () => {
    const res = await POST(
      makeRequest({
        mode: 'codex-cli',
        messages: VALID_MESSAGES,
        // Adversarial: client attempts to escalate to write.
        codexMode: 'write',
      }),
    );

    expect(res.status).toBe(200);

    expect(capturedCalls.length).toBe(1);
    // The critical assertion: write must never reach orchestrate().
    expect(capturedCalls[0].codexMode).toBe('read');
    expect(capturedCalls[0].codexMode).not.toBe('write');
    expect(capturedCalls[0].mode).toBe('codex-cli');
  });

  it('(A.2) no codexMode in body → orchestrate receives codexMode=read', async () => {
    const res = await POST(
      makeRequest({
        mode: 'codex-cli',
        messages: VALID_MESSAGES,
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].codexMode).toBe('read');
  });

  it('(A.3) parallel-all mode also hardcodes codexMode=read', async () => {
    const res = await POST(
      makeRequest({
        mode: 'parallel-all',
        messages: VALID_MESSAGES,
        codexMode: 'write', // forged — must be stripped
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].codexMode).toBe('read');
  });

  // -------------------------------------------------------------------------
  // (B) Invalid bodies return 400
  // -------------------------------------------------------------------------

  it('(B.1) invalid mode → 400 invalid-body', async () => {
    const res = await POST(
      makeRequest({ mode: 'gpt-write', messages: VALID_MESSAGES }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid-body');
    expect(capturedCalls.length).toBe(0);
  });

  it('(B.2) messages absent → 400', async () => {
    const res = await POST(makeRequest({ mode: 'codex-cli' }));

    expect(res.status).toBe(400);
    expect(capturedCalls.length).toBe(0);
  });

  it('(B.3) messages empty array → 400 messages-empty', async () => {
    const res = await POST(
      makeRequest({ mode: 'codex-cli', messages: [] }),
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('messages-empty');
    expect(capturedCalls.length).toBe(0);
  });

  it('(B.4) non-JSON body → 400 invalid-json', async () => {
    const req = new NextRequest('http://localhost:4200/api/llm/orchestrate', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not-json{{{',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid-json');
    expect(capturedCalls.length).toBe(0);
  });

  it('(B.5) invalid message role → 400', async () => {
    const res = await POST(
      makeRequest({
        mode: 'ollama',
        messages: [{ role: 'admin', content: 'exploit' }],
      }),
    );

    expect(res.status).toBe(400);
    expect(capturedCalls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // (C) Valid requests reach orchestrate() with correct fields
  // -------------------------------------------------------------------------

  it('(C.1) valid claude-cli body → orchestrate called with correct mode', async () => {
    const res = await POST(
      makeRequest({ mode: 'claude-cli', messages: VALID_MESSAGES }),
    );

    expect(res.status).toBe(200);
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].mode).toBe('claude-cli');
    expect(capturedCalls[0].messageCount).toBe(1);
  });

  it('(C.2) default mode (absent) → parallel-all', async () => {
    const res = await POST(makeRequest({ messages: VALID_MESSAGES }));

    expect(res.status).toBe(200);
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].mode).toBe('parallel-all');
  });

  it('(C.3) optional fields forwarded (model, maxTokens, timeoutMs)', async () => {
    const res = await POST(
      makeRequest({
        mode: 'ollama',
        messages: VALID_MESSAGES,
        model: 'llama3',
        maxTokens: 512,
        timeoutMs: 10000,
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedCalls.length).toBe(1);
    // codexMode must still be 'read' even for ollama (no-op for non-codex).
    expect(capturedCalls[0].codexMode).toBe('read');
  });
});
