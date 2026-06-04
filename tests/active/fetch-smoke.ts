/**
 * tests/active/fetch-smoke.ts
 *
 * Read-only HTTP-Smoke gegen die LAUFENDE Instanz (default :4200).
 *
 * Strategie:
 *   - Auth via master-login → echtes Session-Cookie.
 *   - Jeder Flow ist ein eigener record() — pass/fail/warn separat.
 *   - KEIN POST das State ändert (außer master-login + opt-in
 *     permission-mode-round-trip mit Snapshot→Restore).
 *
 * Run:
 *   set -a && source .env.local && set +a
 *   pnpm exec tsx tests/active/fetch-smoke.ts
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { getSessionCookie, bearerHeader, SMOKE_BASE_URL } from './utils/auth';
import { record, writeJsonReport, exitCodeFromResults } from './utils/report';

const REPO = path.resolve(__dirname, '..', '..');

interface ProbeOpts {
  url: string;
  method?: 'GET' | 'POST' | 'PATCH';
  cookie?: string;
  bearer?: boolean;
  body?: unknown;
  expect?: number | number[];
  /** Wenn gesetzt, wird der Body-Snippet (max 200 chars) in evidence festgehalten. */
  captureBody?: boolean;
}

interface ProbeResult {
  status: number;
  bodySnippet: string;
  headers: Record<string, string>;
  ms: number;
}

async function probe(opts: ProbeOpts): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    'user-agent': 'lazyos-active-smoke/1.0',
  };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) {
    const b = bearerHeader();
    if (b) headers.authorization = b.authorization;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const t0 = performance.now();
  const res = await fetch(opts.url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  const ms = Math.round(performance.now() - t0);
  let bodySnippet = '';
  if (opts.captureBody !== false) {
    const text = await res.text();
    bodySnippet = text.slice(0, 200);
  } else {
    await res.body?.cancel();
  }
  const hdr: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    hdr[k] = v;
  });
  return { status: res.status, bodySnippet, headers: hdr, ms };
}

async function main(): Promise<void> {
  // --- Flow 1: Boot-Smoke ---
  // GET / unauth → 307 → /login. Login-Page muss 200 sein.
  {
    const root = await probe({ url: `${SMOKE_BASE_URL}/`, expect: 307 });
    if (root.status !== 307) {
      record({
        name: '1a. GET / unauth → 307',
        status: 'fail',
        evidence: `expected 307, got ${root.status}. body: ${root.bodySnippet}`,
        durationMs: root.ms,
      });
    } else if ((root.headers.location ?? '').indexOf('/login') === -1) {
      record({
        name: '1a. GET / unauth → 307',
        status: 'fail',
        evidence: `redirect location wrong: ${root.headers.location}`,
        durationMs: root.ms,
      });
    } else {
      record({
        name: '1a. GET / unauth → 307 /login',
        status: 'pass',
        evidence: `307 → ${root.headers.location}`,
        durationMs: root.ms,
      });
    }

    const login = await probe({ url: `${SMOKE_BASE_URL}/login` });
    record({
      name: '1b. GET /login → 200',
      status: login.status === 200 ? 'pass' : 'fail',
      evidence: `${login.status}; body starts: ${login.bodySnippet.slice(0, 80)}…`,
      durationMs: login.ms,
    });
  }

  // --- Flow 2: Auth + /workspaces render ---
  let cookie = '';
  try {
    cookie = await getSessionCookie();
    record({
      name: '2a. master-login → session cookie',
      status: 'pass',
      evidence: `cookie acquired: ${cookie.split('=')[0]}=… (len ${cookie.length})`,
    });
  } catch (e) {
    record({
      name: '2a. master-login → session cookie',
      status: 'fail',
      evidence: String((e as Error).message),
    });
    writeJsonReport(path.join(REPO, 'docs/audits/2026-05-28_active-test-smoke-report.json'));
    process.exit(exitCodeFromResults());
    return;
  }

  {
    const r = await probe({ url: `${SMOKE_BASE_URL}/workspaces`, cookie });
    record({
      name: '2b. GET /workspaces (authed) → 200',
      status: r.status === 200 ? 'pass' : 'fail',
      evidence: `${r.status}; html-len ${r.bodySnippet.length}`,
      durationMs: r.ms,
    });
  }

  // --- Flow 3: Page-Render-Smokes (alle authed) ---
  // Erwartete Routes; jede die nicht 200 ist → fail, aber wir machen NICHT
  // halt — Sammlung ist wertvoller als Abbruch.
  // Pages and their expected outcomes. For routes that redirect on purpose
  // (e.g. /lanes → /workstreams?view=kanban, /orgs → /orgs/<active>) the
  // expectation is "redirect to a non-login target" — login-redirect is a
  // fail because that means our session is being rejected.
  const pages: Array<{ p: string; want: 'render' | 'app-redirect' | 'not-found'; note?: string }> = [
    { p: '/', want: 'render' },
    { p: '/workspaces', want: 'render' },
    { p: '/workflows', want: 'render' },
    { p: '/tickets', want: 'render' },
    { p: '/skills', want: 'render' },
    { p: '/decisions', want: 'render' },
    { p: '/lanes', want: 'app-redirect', note: 'redirects to /workstreams?view=kanban (app/lanes/page.tsx:15)' },
    { p: '/calendar', want: 'render' },
    { p: '/inbox', want: 'render' },
    { p: '/settings', want: 'render' },
    { p: '/innovate', want: 'not-found', note: 'innovate has only [scope] sub-routes, no top-level page' },
    { p: '/observatory', want: 'render' },
    { p: '/how', want: 'render' },
    { p: '/sessions', want: 'render' },
    { p: '/welcome', want: 'render' },
    { p: '/whats-new', want: 'render' },
    { p: '/design', want: 'render' },
    { p: '/orgs', want: 'app-redirect', note: 'redirects to /orgs/<active> (app/orgs/page.tsx)' },
    { p: '/features', want: 'render', note: 'parallel-agent builds this — currently 404 expected if not landed' },
  ];

  for (const { p, want, note } of pages) {
    const r = await probe({ url: `${SMOKE_BASE_URL}${p}`, cookie });
    const loc = r.headers.location ?? '';
    const isLoginRedirect = r.status === 307 && loc.includes('/login');
    let status: 'pass' | 'fail' | 'warn' | 'skip' = 'fail';
    let evidence = `${r.status}${loc ? ` → ${loc}` : ''}`;
    if (isLoginRedirect) {
      status = 'fail';
      evidence = `Session rejected: ${r.status} → ${loc} (cookie len ${cookie.length})`;
    } else if (want === 'render') {
      status = r.status === 200 ? 'pass' : p === '/features' && r.status === 404 ? 'skip' : 'fail';
    } else if (want === 'app-redirect') {
      status = r.status === 307 && !loc.includes('/login') ? 'pass' : 'fail';
    } else if (want === 'not-found') {
      status = r.status === 404 ? 'pass' : 'fail';
    }
    if (note) evidence += `\nNOTE: ${note}`;
    record({ name: `3. GET ${p}`, status, evidence, durationMs: r.ms });
  }

  // --- Flow 4: 401/403-Reproduktion auf /api/permission/__root__/mode ---
  // Owner-Kontext: das vorherige 403 wurde auf der UI verursacht weil die
  // Page eine __root__-Permission-Probe macht (es gibt keinen Workspace
  // namens __root__). Erwartete Klassifizierung:
  //   401 ohne Cookie → Regression (Auth-Path bricht);
  //   401 mit Cookie → Regression (Cookie wird nicht erkannt);
  //   403 mit Cookie → erwartet (kein Workspace __root__ in DB);
  //   200            → erwartet (wenn die UI eine echte Workspace-ID
  //                   stattdessen verwenden würde).
  // Owner-Aufgabe: die *aufrufende* UI sollte gar keine __root__-Probe
  // schicken (das ist Lärm in der Console). FAIL ist nur 401 mit Cookie.
  {
    const r = await probe({
      url: `${SMOKE_BASE_URL}/api/permission/__root__/mode`,
      cookie,
    });
    const isRegression = r.status === 401;
    record({
      name: '4. GET /api/permission/__root__/mode (authed) — Permission-Repro',
      status: isRegression
        ? 'fail'
        : r.status === 403
          ? 'warn'
          : r.status === 200
            ? 'pass'
            : 'fail',
      evidence:
        `${r.status}; body: ${r.bodySnippet}\n` +
        `NOTE: 403 with valid session means the *caller* is asking for a non-existent ` +
        `workspace "__root__" — the route is correct, the UI shouldn't probe __root__. ` +
        `Search for callers: \`grep -rn "permission/__root__/mode" app/ lib/ components/\`.`,
      expectedBackend:
        'app/api/permission/[workspaceId]/mode/route.ts:67 (auth) | :69 (hasRealWorkspaceMembership)',
      durationMs: r.ms,
    });
  }

  // --- Flow 5: API-Inventur (read-only) ---
  // Diese Endpoints sollen mit Session-Cookie 200 sein. 401 ist Regression.
  // expected-codes: [200], [200, 404] (404 = endpoint not present, dokumentieren),
  // 405 = POST-only (Regel: nicht als fail werten).
  const readApis: Array<{ p: string; ok: number[]; note?: string }> = [
    { p: '/api/health', ok: [200] },
    { p: '/api/system/health', ok: [200] },
    { p: '/api/system/engines', ok: [200] },
    { p: '/api/workspaces', ok: [200] },
    { p: '/api/workspaces/list', ok: [200, 404], note: 'workspace list endpoint may not exist (use /api/workspaces).' },
    { p: '/api/tickets', ok: [200] },
    { p: '/api/skills', ok: [200] },
    { p: '/api/workflows', ok: [200] },
    { p: '/api/sessions', ok: [200] },
    { p: '/api/feedback', ok: [200, 405], note: 'POST-only allowed.' },
    { p: '/api/agents/status', ok: [200] },
    { p: '/api/quota/tpm-status', ok: [200] },
    { p: '/api/heartbeat/tick', ok: [200, 401, 405], note: 'cron-tick endpoint — bearer-protected internal route, 401 with cookie-only is expected.' },
  ];
  for (const { p, ok: expected, note } of readApis) {
    const r = await probe({ url: `${SMOKE_BASE_URL}${p}`, cookie });
    const ok = expected.includes(r.status);
    record({
      name: `5. GET ${p}`,
      status: ok ? 'pass' : 'fail',
      evidence: `${r.status}; body: ${r.bodySnippet.slice(0, 140)}${note ? `\nNOTE: ${note}` : ''}`,
      durationMs: r.ms,
    });
  }

  // --- Flow 6: Bearer-Auth-Sanity ---
  // Bearer ist nur für /api/*-Service-Calls. Wir prüfen dass /api/health auch
  // mit Bearer funktioniert UND dass /api/permission/.../mode mit Bearer
  // (also ohne Cookie) ehrlich 401 zurückgibt — sonst ist die Auth-Trennung
  // gebrochen.
  {
    const r = await probe({ url: `${SMOKE_BASE_URL}/api/health`, bearer: true });
    record({
      name: '6a. GET /api/health (bearer)',
      status: r.status === 200 ? 'pass' : 'fail',
      evidence: `${r.status}; body: ${r.bodySnippet.slice(0, 80)}`,
      durationMs: r.ms,
    });
  }
  {
    const r = await probe({
      url: `${SMOKE_BASE_URL}/api/permission/__root__/mode`,
      bearer: true,
    });
    const expected = r.status === 401 && r.bodySnippet.includes('auth-required');
    record({
      name: '6b. GET /api/permission/__root__/mode (bearer-only, no cookie) → 401 auth-required',
      status: expected ? 'pass' : 'warn',
      evidence: `${r.status}; body: ${r.bodySnippet}`,
      expectedBackend:
        'app/api/permission/[workspaceId]/mode/route.ts:67 — currentUserIdResolved() returns null for agent:cli subject (Bearer maps to agent, not user).',
      durationMs: r.ms,
    });
  }

  // --- Flow 7: Permission-Mode-Round-Trip (read-only Subset) ---
  // GET je Workspace aus /api/health-Manifest. Real-Workspaces sollten 200
  // mit { mode: 'freerein'|'lane'|'ask'|'freerein-with-audit' } liefern.
  {
    const h = await probe({ url: `${SMOKE_BASE_URL}/api/health` });
    let wsIds: string[] = [];
    try {
      const j = JSON.parse(h.bodySnippet) as { segments?: Array<{ id: string }> };
      wsIds = (j.segments ?? []).map((s) => s.id).slice(0, 3);
    } catch {
      // ignore — h.bodySnippet capped at 200 chars
    }
    if (wsIds.length === 0) {
      record({
        name: '7. Permission-Mode read per workspace',
        status: 'skip',
        evidence: 'no workspaces in /api/health (truncated body — re-fetching full)',
      });
      // Re-fetch full healthz so we can iterate properly.
      const full = await fetch(`${SMOKE_BASE_URL}/api/health`);
      const j = (await full.json()) as { segments?: Array<{ id: string }> };
      wsIds = (j.segments ?? []).map((s) => s.id);
    }
    for (const id of wsIds) {
      const r = await probe({
        url: `${SMOKE_BASE_URL}/api/permission/${encodeURIComponent(id)}/mode`,
        cookie,
      });
      const ok = r.status === 200 || r.status === 403; // 403 = real-membership-check, also legitimer Befund
      record({
        name: `7. GET /api/permission/${id}/mode`,
        status: ok ? 'pass' : 'fail',
        evidence: `${r.status}; body: ${r.bodySnippet.slice(0, 140)}`,
        expectedBackend: 'app/api/permission/[workspaceId]/mode/route.ts:69 (hasRealWorkspaceMembership)',
        durationMs: r.ms,
      });
    }
  }

  // --- Flow 8: RAG-Endpoints (read-only) ---
  // /api/rag/status braucht workspaceId? — wir probieren plain + scoped.
  // Erwartung: scoped 200; plain 400 (workspaceId required) ist OK.
  {
    const r0 = await probe({ url: `${SMOKE_BASE_URL}/api/rag/status`, cookie });
    record({
      name: '8a. GET /api/rag/status (no workspaceId)',
      status: r0.status === 400 ? 'pass' : r0.status === 404 ? 'warn' : 'fail',
      evidence: `${r0.status}; body: ${r0.bodySnippet.slice(0, 160)}`,
      durationMs: r0.ms,
    });

    // Pick first workspace and re-query.
    const h = await fetch(`${SMOKE_BASE_URL}/api/health`);
    const hj = (await h.json()) as { segments?: Array<{ id: string }> };
    const wsId = hj.segments?.[0]?.id;
    if (wsId) {
      const r = await probe({
        url: `${SMOKE_BASE_URL}/api/rag/status?workspaceId=${encodeURIComponent(wsId)}`,
        cookie,
      });
      record({
        name: `8b. GET /api/rag/status?workspaceId=${wsId}`,
        status: r.status === 200 ? 'pass' : 'fail',
        evidence: `${r.status}; body: ${r.bodySnippet.slice(0, 200)}`,
        durationMs: r.ms,
      });
    }
  }

  // --- Flow 9: Self-Learning DB-Trigger via /api/system/health ---
  // Indikator für WARUM-Engine: workspace_beliefs / decision_outcomes counts.
  // Endpoint sollte sie zumindest read-only durchreichen (wenn vorhanden).
  {
    const r = await probe({ url: `${SMOKE_BASE_URL}/api/system/health` });
    record({
      name: '9. GET /api/system/health (engine + memory)',
      status: r.status === 200 ? 'pass' : 'fail',
      evidence: `${r.status}; body: ${r.bodySnippet.slice(0, 200)}`,
      durationMs: r.ms,
    });
  }

  // --- Flow 10: Mobile-Headers — Settings Page mit iPhone-UA ---
  // Funktioniert nicht für echte Layout-Detection (keine Browser-Engine),
  // aber stellt sicher dass die SSR-Response 200 ist und kein UA-Sniff-Crash.
  {
    const r = await fetch(`${SMOKE_BASE_URL}/settings`, {
      headers: {
        cookie,
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
      redirect: 'manual',
    });
    const txt = (await r.text()).slice(0, 100);
    record({
      name: '10. GET /settings (iPhone-UA)',
      status: r.status === 200 ? 'pass' : 'fail',
      evidence: `${r.status}; html-start: ${txt}`,
    });
  }

  // --- Write JSON artefact for the Markdown report ---
  const outJson = path.join(REPO, 'docs/audits/2026-05-28_active-test-smoke-report.json');
  writeJsonReport(outJson);
  console.log(`\nWrote ${outJson}`);
  process.exit(exitCodeFromResults());
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('fetch-smoke crashed:', e);
  process.exit(2);
});
