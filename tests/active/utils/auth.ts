/**
 * tests/active/utils/auth.ts
 *
 * Hol ein Session-Cookie über master-login. Read-only-freundlich: der
 * Master-Code wird nicht persistiert, der Cookie nur in-memory weiter-
 * gereicht. Für Bearer-Calls auf reine /api/*-Health/-Read-Endpoints
 * gibt es zusätzlich `bearerHeader()` — der reicht aber NICHT für
 * Permission/-UI-Routes (die rufen currentUserIdResolved).
 */

const BASE = process.env.LAZYOS_SMOKE_BASE_URL ?? 'http://127.0.0.1:4200';

let cachedCookie: string | null = null;

/**
 * Liest LAZYOS_ACCESS_CODE aus dem aktuellen Prozess-Env (`.env.local`
 * muss vorher gesourced sein) und tauscht das gegen ein lazyos_session-
 * Cookie.
 *
 * @throws wenn das Env fehlt oder der Login fehlschlägt.
 */
export async function getSessionCookie(): Promise<string> {
  if (cachedCookie) return cachedCookie;
  const accessCode = process.env.LAZYOS_ACCESS_CODE;
  if (!accessCode || accessCode.length < 16) {
    throw new Error(
      'getSessionCookie: LAZYOS_ACCESS_CODE not set (run `set -a && source .env.local && set +a` first).',
    );
  }
  const res = await fetch(`${BASE}/api/auth/master-login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE,
    },
    body: JSON.stringify({ accessCode }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`master-login failed: ${res.status} ${body}`);
  }
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('master-login returned 200 but no set-cookie header');
  }
  // "lazyos_session=…; Path=/; …" → "lazyos_session=…"
  const sessionPart = setCookie.split(';')[0];
  if (!sessionPart.startsWith('lazyos_session=')) {
    throw new Error(`unexpected cookie name: ${sessionPart.slice(0, 30)}`);
  }
  cachedCookie = sessionPart;
  return cachedCookie;
}

/**
 * Bearer header for /api/* health/read routes. NICHT für UI-/Permission-
 * Routes — die brauchen das Session-Cookie weil `currentUserIdResolved`
 * den `user:*`-Subject braucht und Bearer nur `agent:cli` setzt.
 */
export function bearerHeader(): { authorization: string } | null {
  const key = process.env.LAZYOS_CHAT_KEY ?? process.env.LAZYOS_CLI_KEY;
  if (!key || key.length < 16) return null;
  return { authorization: `Bearer ${key}` };
}

export const SMOKE_BASE_URL = BASE;
