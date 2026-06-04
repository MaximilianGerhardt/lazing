/**
 * verify-external-sse-ratelimit.mjs — End-to-End-Beweis für:
 *  (1) Token-SSE: externer Gast bekommt eine neue Nachricht in Echtzeit (Ping).
 *  (2) Rate-Limit: der strikte Prefix-Policy (POST 20/min, burst 8) greift auf
 *      `/api/subchats/external/` (vorher fiel es auf DEFAULT 600/min).
 *
 * Erzeugt einen WEGWERF-Subchat (extern) in `intern`, testet, und LÖSCHT ihn
 * wieder (inkl. der erzeugten Nachricht). Kein bleibendes Testdaten-Residuum.
 *
 * ENV: SESSION_COOKIE="lazyos_session=<value>"
 */

const BASE = process.env.BASE || 'http://127.0.0.1:4200';
const COOKIE = process.env.SESSION_COOKIE;
const WS = process.env.TEST_WS || 'intern';
const out = { sse: {}, rateLimit: {}, cleanup: {} };

function authHeaders(extra = {}) {
  return { cookie: COOKIE, 'content-type': 'application/json', ...extra };
}

// --- 1. Wegwerf-Subchat (extern) anlegen → Token ---------------------------
const createRes = await fetch(`${BASE}/api/workspaces/${encodeURIComponent(WS)}/subchats`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify({ title: 'SSE-Verify (Wegwerf)', kind: 'external' }),
});
const created = await createRes.json();
const externalUrl = created.externalUrl || '';
const tokenMatch = externalUrl.match(/\/c\/([^/?#]+)/) || externalUrl.match(/external\/([^/?#]+)/);
const token = tokenMatch ? tokenMatch[1] : null;
// subchatId für Cleanup: aus der Liste holen.
let subchatId = created.subchat?.id || created.id || null;
if (!subchatId) {
  const list = await fetch(`${BASE}/api/workspaces/${encodeURIComponent(WS)}/subchats`, { headers: { cookie: COOKIE } }).then((r) => r.json());
  subchatId = (list.subchats || []).find((s) => s.title === 'SSE-Verify (Wegwerf)')?.id ?? null;
}
out.sse.tokenObtained = !!token;
out.sse.subchatId = subchatId;

if (!token) {
  console.log(JSON.stringify({ error: 'no-token', created }, null, 2));
  process.exit(1);
}

// --- 2. SSE öffnen + parallel eine externe Nachricht posten ----------------
const ac = new AbortController();
let sawPing = false;
let sawConnected = false;
const ssePromise = (async () => {
  const res = await fetch(`${BASE}/api/subchats/external/${encodeURIComponent(token)}/stream`, {
    headers: { accept: 'text/event-stream' },
    signal: ac.signal,
  });
  out.sse.streamStatus = res.status;
  out.sse.contentType = res.headers.get('content-type');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes(': connected')) sawConnected = true;
      if (buf.includes('"type":"subchat_message"')) {
        sawPing = true;
        break;
      }
    }
  } catch {
    /* aborted */
  }
})();

// kurz warten bis SSE connected, dann posten
await new Promise((r) => setTimeout(r, 800));
const postRes = await fetch(`${BASE}/api/subchats/external/${encodeURIComponent(token)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: BASE },
  body: JSON.stringify({ name: 'SSE-Tester', content: 'Realtime-Probe ' + 'x'.repeat(4) }),
});
out.sse.postStatus = postRes.status;

// auf Ping warten (max 6s)
await Promise.race([ssePromise, new Promise((r) => setTimeout(r, 6000))]);
ac.abort();
out.sse.sawConnected = sawConnected;
out.sse.sawRealtimePing = sawPing;

// --- 3. Rate-Limit: POST hammern (invalid body → 400, zählt aber gegen RL) --
// burst 8 → erste ~8 kommen durch (400 invalid-content), danach 429.
const codes = [];
for (let i = 0; i < 16; i++) {
  const r = await fetch(`${BASE}/api/subchats/external/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ name: 'rl', content: '' }), // invalid → 400 (oder 429 wenn rate-limited)
  });
  codes.push(r.status);
}
out.rateLimit.codes = codes;
out.rateLimit.got429 = codes.includes(429);
out.rateLimit.first = codes[0];

// --- 4. Cleanup: Wegwerf-Subchat löschen -----------------------------------
if (subchatId) {
  const del = await fetch(`${BASE}/api/subchats/${encodeURIComponent(subchatId)}`, {
    method: 'DELETE',
    headers: { cookie: COOKIE },
  });
  out.cleanup.deleteStatus = del.status;
}

out.VERDICT =
  out.sse.streamStatus === 200 &&
  out.sse.sawRealtimePing === true &&
  out.rateLimit.got429 === true &&
  (out.cleanup.deleteStatus === 200 || out.cleanup.deleteStatus === 204)
    ? 'PASS'
    : 'FAIL';

console.log(JSON.stringify(out, null, 2));
