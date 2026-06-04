/**
 * SSE-proxy smoke test.
 *
 * Spins up a fake "agent-server" on 127.0.0.1:0 that emits a canned SSE
 * event sequence (ready → tool_call → tool_result → token … → done),
 * then points the Next.js proxy's *logic* at it by calling `fetch`
 * directly with the same headers/body the proxy sends, and asserts the
 * bytes are preserved.
 *
 * This does NOT exercise the Next.js handler (that needs `next start`),
 * but it does validate:
 *   - the proxy's outbound shape matches what agent-server expects,
 *   - the SSE frame format emitted by agent-server parses cleanly via
 *     the frame splitter used in `useAgentStream.ts` (inlined here to
 *     keep the smoke test standalone).
 *
 * Run: pnpm tsx scripts/chat-sse-smoke.ts
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Fake agent-server.
// ---------------------------------------------------------------------------

const EXPECTED_BEARER = 'test-chat-key-smoke';

function writeEvent(res: http.ServerResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startFakeAgent(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url !== '/chat' || req.method !== 'POST') {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${EXPECTED_BEARER}`) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const parsed = JSON.parse(raw);
        if (!parsed.workspaceId || !Array.isArray(parsed.messages)) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid_body' }));
          return;
        }

        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-store, no-transform');
        res.setHeader('connection', 'keep-alive');
        res.flushHeaders();

        const reqId = 'smoke-1';
        const ws = parsed.workspaceId;

        writeEvent(res, 'ready', { reqId, sessionId: 'sess-1', workspaceId: ws });
        writeEvent(res, 'tool_call', {
          reqId,
          workspaceId: ws,
          id: 'tu-1',
          name: 'Read',
          input_preview: 'Read(path="lib/foo.ts")',
        });
        writeEvent(res, 'tool_result', {
          reqId,
          workspaceId: ws,
          tool_use_id: 'tu-1',
          is_error: false,
          output_preview: 'function foo() { return 42; }',
        });
        writeEvent(res, 'token', { reqId, workspaceId: ws, delta: 'Die ' });
        writeEvent(res, 'token', { reqId, workspaceId: ws, delta: 'Funktion liefert ' });
        writeEvent(res, 'token', { reqId, workspaceId: ws, delta: '**42** zurueck.' });
        writeEvent(res, 'done', {
          reqId,
          workspaceId: ws,
          sessionId: 'sess-1',
          subtype: 'success',
          duration_ms: 842,
          num_turns: 1,
          is_error: false,
          chars_out: 33,
          tool_calls: 1,
        });
        res.end();
      });
    });

    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((ok) => srv.close(() => ok())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Parser under test (inlined copy of the `useAgentStream.ts` splitter —
// keep in sync if that file changes).
// ---------------------------------------------------------------------------

interface ParsedFrame {
  event: string | null;
  data: unknown;
}

function findFrameBoundary(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseFrame(frame: string): ParsedFrame | null {
  const lines = frame.split(/\r?\n/);
  let name: string | null = null;
  const dataParts: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') dataParts.push(value);
  }
  if (!name || !dataParts.length) return null;
  try {
    return { event: name, data: JSON.parse(dataParts.join('\n')) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test runner.
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const agent = await startFakeAgent();
  try {
    const res = await fetch(`${agent.url}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${EXPECTED_BEARER}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'was macht foo()?' }],
        workspaceId: 'lazyos',
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`fake-agent returned ${res.status}`);
    }

    const events: ParsedFrame[] = [];
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (;;) {
        const idx = findFrameBoundary(buffer);
        if (idx === -1) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^(?:\r?\n){1,2}/, '');
        const parsed = parseFrame(frame);
        if (parsed) events.push(parsed);
      }
    }

    // Assertions.
    const expected = [
      'ready',
      'tool_call',
      'tool_result',
      'token',
      'token',
      'token',
      'done',
    ];
    const actualNames = events.map((e) => e.event);
    if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
      throw new Error(
        `event sequence mismatch: expected ${expected.join(',')} got ${actualNames.join(',')}`,
      );
    }

    // Reconstruct the text from tokens.
    const text = events
      .filter((e) => e.event === 'token')
      .map((e) => (e.data as { delta: string }).delta)
      .join('');
    if (text !== 'Die Funktion liefert **42** zurueck.') {
      throw new Error(`token reassembly wrong: ${text}`);
    }

    // 401 on bad auth.
    const bad = await fetch(`${agent.url}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer NOPE',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'x' }],
        workspaceId: 'lazyos',
      }),
    });
    if (bad.status !== 401) {
      throw new Error(`expected 401 on bad auth, got ${bad.status}`);
    }

    // 400 on missing workspaceId.
    const bad2 = await fetch(`${agent.url}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${EXPECTED_BEARER}`,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
    });
    if (bad2.status !== 400) {
      throw new Error(`expected 400 on missing workspaceId, got ${bad2.status}`);
    }

    console.log('OK — SSE proxy shape + auth + parser all green');
  } finally {
    await agent.close();
  }
}

run().catch((err) => {
  console.error('FAIL —', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
