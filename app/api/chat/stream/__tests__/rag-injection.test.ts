/**
 * RAG-Injection in /api/chat/stream — Orchestrator-Pfade (TG-1 Audit-Fix)
 *
 * Audit-Befund (docs/audits/2026-05-28_ux-redundancy-flow-audit.md, TG-1 P0):
 *   - app/api/chat/stream/route.ts hatte 0 retrieveAcrossWorkspaces-Imports.
 *   - Live-DB hatte 322 rag_chunks, der Chat las sie nicht.
 *
 * Fix: für die Orchestrator-Pfade (ollama / parallel-all / codex-cli) wird
 * vor dem orchestrate()-Call ein workspace-scoped RAG-Block via
 * buildRagSystemBlock(workspaceId, lastUserContent) gebaut und als führende
 * 'system'-Message an die orchestrate-messages prepended. Der claude-cli-
 * Pfad bleibt unangetastet — dort macht server/workspace-session.ts:1299
 * die Injektion (Doppel-Injection vermeiden).
 *
 * Diese Tests verifizieren:
 *   (1) Orchestrator-Pfad mit RAG-Hits → orchestrate() bekommt eine führende
 *       system-Message, deren content den formatForPrompt-Block enthält.
 *   (2) Orchestrator-Pfad mit 0 rag_chunks (COUNT-Guard) → KEINE system-
 *       Message, body.messages unverändert (null Embed-Call, null Latenz-Add).
 *   (3) Orchestrator-Pfad mit retrieve-Fehler → fail-soft: KEINE system-
 *       Message, orchestrate läuft trotzdem normal durch.
 *   (4) claude-cli-Pfad (default) → KEINE RAG-Injection im Route-Layer
 *       (das macht workspace-session.ts downstream).
 *
 * Mock-Architektur:
 *   - Wir hoisten vi.mock() für '@/lib/rag/retriever', '@/db/client',
 *     '@/lib/llm/orchestrator'.
 *   - Pro Test setzen wir den DB-COUNT-Mock und den retrieve-Mock je nach
 *     Szenario.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     app/api/chat/stream/__tests__/rag-injection.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Shared mock state (module-scope closure — vi.mock-Hoisting kompatibel)
// ---------------------------------------------------------------------------

interface CapturedOrchestrate {
  mode: string;
  messages: Array<{ role: string; content: string }>;
  codexMode?: string;
}
const capturedOrchestrate: CapturedOrchestrate[] = [];

interface RetrieveCall {
  workspaceId: string;
  query: string;
  topK?: number;
  tokenCap?: number;
}
const capturedRetrieveCalls: RetrieveCall[] = [];

// Mutable mock state — pro Test umschaltbar via beforeEach.
const ragState: {
  chunkCount: number;
  retrieveResult: { hits: unknown[]; formatted: string } | null;
  retrieveThrows: boolean;
} = {
  chunkCount: 0,
  retrieveResult: null,
  retrieveThrows: false,
};

// ---------------------------------------------------------------------------
// vi.mock-Hoists
// ---------------------------------------------------------------------------

vi.mock('@/lib/llm/orchestrator', () => ({
  orchestrate: async (req: {
    mode: string;
    codexMode?: string;
    messages: Array<{ role: string; content: string }>;
  }) => {
    capturedOrchestrate.push({
      mode: req.mode,
      messages: req.messages,
      codexMode: req.codexMode,
    });
    return {
      engine: req.mode === 'parallel-all' ? 'ollama' : req.mode,
      mode: req.mode,
      model: 'mock-model',
      text: 'mock response',
      latencyMs: 5,
      attempts: [],
    };
  },
}));

vi.mock('@/lib/rag/retriever', () => ({
  retrieve: async (args: RetrieveCall) => {
    capturedRetrieveCalls.push(args);
    if (ragState.retrieveThrows) {
      throw new Error('mock retrieve fail');
    }
    return ragState.retrieveResult ?? { hits: [], totalCandidates: 0 };
  },
  formatForPrompt: (result: { hits: unknown[] }) => {
    if (ragState.retrieveResult && ragState.retrieveResult.hits.length > 0) {
      return ragState.retrieveResult.formatted;
    }
    if (result.hits.length === 0) return '';
    return '## Workspace-Kontext (RAG)\n[passthrough]';
  },
}));

// db/client: $raw.prepare(sql).get(workspaceId) → { n: chunkCount }
vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: (_sql: string) => ({
        get: (_workspaceId: string) => ({ n: ragState.chunkCount }),
      }),
    },
  }),
}));

vi.mock('@/lib/events/emit', () => ({
  emitChatMessageSent: async () => undefined,
  emitChatMessageCompleted: async () => undefined,
}));

vi.mock('@/lib/chat/ledger', () => ({
  appendLedgerRow: () => undefined,
}));

vi.mock('@/lib/security/subject', () => ({
  currentSubject: () => ({ type: 'user', id: 'test-user' }),
}));

vi.mock('@/lib/ulid', () => ({
  ulid: () => 'mock-ulid-rag00',
}));

// ---------------------------------------------------------------------------
// Helpers
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

async function drainSse(res: Response): Promise<string> {
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

const BASE_BODY = {
  messages: [{ role: 'user', content: 'wie deploye ich example-website?' }],
  workspaceId: 'example-website',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/chat/stream — RAG-Injection in Orchestrator-Pfaden (TG-1)', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    capturedOrchestrate.length = 0;
    capturedRetrieveCalls.length = 0;
    ragState.chunkCount = 0;
    ragState.retrieveResult = null;
    ragState.retrieveThrows = false;
    process.env.LAZYOS_AGENT_URL = 'http://127.0.0.1:4201';
    process.env.LAZYOS_CHAT_KEY = 'mock-chat-key';
    vi.resetModules();
    const mod = await import('../route');
    POST = mod.POST;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(1) ollama-Pfad mit 2 Hits → orchestrate bekommt führende system-Message mit RAG-Block', async () => {
    ragState.chunkCount = 2;
    ragState.retrieveResult = {
      hits: [
        { id: 'c1', text: 'Deploy via vercel --prod', similarity: 0.91 },
        { id: 'c2', text: 'Env LAZYOS_AGENT_URL via Cloudflare-Tunnel', similarity: 0.78 },
      ],
      formatted:
        '## Workspace-Kontext (RAG · 2/2 Chunks · intent=howto)\n' +
        '### Kontext-Treffer 1 · file:DEPLOY.md · sim=0.91\nDeploy via vercel --prod\n\n' +
        '### Kontext-Treffer 2 · file:.env.example · sim=0.78\nEnv LAZYOS_AGENT_URL via Cloudflare-Tunnel\n',
    };

    const req = makeStreamRequest({ ...BASE_BODY, engineMode: 'ollama' });
    const res = await POST(req);
    await drainSse(res);

    expect(res.status).toBe(200);
    expect(capturedRetrieveCalls).toHaveLength(1);
    expect(capturedRetrieveCalls[0].workspaceId).toBe('example-website');
    expect(capturedRetrieveCalls[0].query).toBe('wie deploye ich example-website?');

    expect(capturedOrchestrate).toHaveLength(1);
    const orch = capturedOrchestrate[0];
    expect(orch.mode).toBe('ollama');
    // Erste Message ist die injizierte system-Message mit RAG-Block.
    expect(orch.messages[0].role).toBe('system');
    expect(orch.messages[0].content).toContain('Workspace-Kontext (RAG');
    expect(orch.messages[0].content).toContain('Deploy via vercel');
    // User-Message bleibt verbatim erhalten.
    expect(orch.messages[1]).toEqual({ role: 'user', content: 'wie deploye ich example-website?' });
  });

  it('(2) parallel-all mit 0 rag_chunks (COUNT-Guard) → keine system-Message, keine retrieve-Call', async () => {
    ragState.chunkCount = 0;
    const req = makeStreamRequest({ ...BASE_BODY, engineMode: 'parallel-all' });
    const res = await POST(req);
    await drainSse(res);

    expect(res.status).toBe(200);
    // COUNT-Guard greift → null Embed-Call → null Latenz-Add.
    expect(capturedRetrieveCalls).toHaveLength(0);
    expect(capturedOrchestrate).toHaveLength(1);
    const orch = capturedOrchestrate[0];
    // body.messages unverändert (kein system prepended).
    expect(orch.messages).toEqual(BASE_BODY.messages);
    // parallel-all forciert codexMode='read' (Sicherheits-Regression-Guard).
    expect(orch.codexMode).toBe('read');
  });

  it('(3) codex-cli mit retrieve-Throw → fail-soft: keine system-Message, orchestrate läuft normal', async () => {
    ragState.chunkCount = 5; // COUNT-Guard passieren lassen → retrieve wird gerufen
    ragState.retrieveThrows = true;

    const req = makeStreamRequest({ ...BASE_BODY, engineMode: 'codex-cli' });
    const res = await POST(req);
    await drainSse(res);

    expect(res.status).toBe(200);
    expect(capturedRetrieveCalls).toHaveLength(1);
    expect(capturedOrchestrate).toHaveLength(1);
    const orch = capturedOrchestrate[0];
    // Fehler im RAG-Pfad → leerer Block → kein system prepended.
    expect(orch.messages).toEqual(BASE_BODY.messages);
    // Sicherheits-Regression-Guard: codex-cli muss IMMER read sein.
    expect(orch.codexMode).toBe('read');
  });

  it('(4) claude-cli (default) → keine RAG-Injection im Route-Layer (kein retrieve-Call)', async () => {
    ragState.chunkCount = 99;
    ragState.retrieveResult = {
      hits: [{ id: 'x', text: 'unused', similarity: 0.99 }],
      formatted: '## should not appear',
    };

    const req = makeStreamRequest({ ...BASE_BODY /* engineMode default = claude-cli */ });
    // claude-cli forwarded an agent-server, der hier nicht erreichbar ist —
    // wir erwarten 502 oder 504 (agent_unreachable / agent_timeout). Wichtig
    // ist: kein retrieve-Call vor dem Forward.
    const res = await POST(req);
    // 502/504 sind OK — wir testen das RAG-Verhalten, nicht den Forward.
    expect([502, 504].includes(res.status)).toBe(true);

    expect(capturedRetrieveCalls).toHaveLength(0);
    expect(capturedOrchestrate).toHaveLength(0);
  });

  it('(5) Kurze Query (<3 Zeichen) → kein retrieve-Call (Guard im Helper)', async () => {
    ragState.chunkCount = 10;
    const req = makeStreamRequest({
      messages: [{ role: 'user', content: 'hi' }],
      workspaceId: 'example-website',
      engineMode: 'ollama',
    });
    const res = await POST(req);
    await drainSse(res);

    expect(res.status).toBe(200);
    // Query.trim().length < 3 → buildRagSystemBlock returnt '' früh, kein
    // Embed-Call.
    expect(capturedRetrieveCalls).toHaveLength(0);
    expect(capturedOrchestrate).toHaveLength(1);
    expect(capturedOrchestrate[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

// ---------------------------------------------------------------------------
// Cross-scope-Audit: Sanity-Check, dass der Route-Layer NIE
// retrieveAcrossWorkspaces aufruft (das wäre N2-Verstoß).
//
// Dieser Test verifiziert die Implementations-Invariante via Quellcode-
// Inspektion — die übliche way-to-go um eine "negative" Code-Eigenschaft
// (function never called) deterministisch festzunageln, ohne den ganzen
// retrieveAcrossWorkspaces-Audit-Stack zu mocken.
// ---------------------------------------------------------------------------

describe('chat/stream — N2 / DSGVO Art. 30 Source-Code-Invariante', () => {
  it('Route-Quellcode importiert/ruft retrieveAcrossWorkspaces NIE auf', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'route.ts'),
      'utf8',
    );
    // Cross-scope-Read erfordert Bridge-Approve + Audit — geht NICHT durch
    // den Default-Chat-Pfad. Hier ist die Invariante hart kodifiziert:
    //   - Kein `import ... retrieveAcrossWorkspaces`
    //   - Kein `retrieveAcrossWorkspaces(` Call
    // Erwähnungen in Code-Kommentaren (zur Doku der Invariante) sind erlaubt
    // und werden via Strip-Comments-Pass aus dem Match-Surface entfernt.
    const noLineComments = src.replace(/^\s*\/\/.*$/gm, '');
    const noBlockComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noBlockComments).not.toMatch(/\bretrieveAcrossWorkspaces\s*\(/);
    expect(noBlockComments).not.toMatch(
      /import[^;]*retrieveAcrossWorkspaces/,
    );
  });
});
