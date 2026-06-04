/**
 * Next.js Edge Middleware — Auth-Gate + Rate-Limit.
 *
 * Runtime constraints:
 *   - Edge runtime: no node:crypto, no better-sqlite3, no fs.
 *   - Web-Crypto (crypto.subtle) works for HMAC; we use that via
 *     lib/security/session + lib/security/crypto.
 *   - Rate-limit state is in-memory per-instance (see lib/security/rate-limit).
 *
 * Logging: We cannot emit to the event log from Edge (it needs
 * better-sqlite3). Instead we forward a minimal log tuple to the
 * response via an `x-lazyos-log` header; the Node route will pick
 * this up via `/api/_internal/log` fetch only for login 401s.
 * For now we just rely on the Node-side auth route logging — the
 * middleware's denies are observable via rate-limit 429 counts.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  checkRateLimit,
  policyFor,
} from "./lib/security/rate-limit";
import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "./lib/security/session";
import {
  hasOnboardedCookie,
  isGateBypassPath,
  isOssMode,
} from "./lib/onboarding/oss-mode";

/**
 * VPS-Bridge bearer gate.
 *
 * When a request arrives with `Authorization: Bearer <LAZYOS_VPS_BRIDGE_SECRET>`
 * AND the env var is set AND the value matches *constant-time*, we treat it
 * as a trusted service-to-service call from the Vercel-edge and bypass the
 * session-cookie check. The rate-limiter still runs.
 *
 * The secret is Node-level only (not Edge-exposed via `NEXT_PUBLIC_`), and
 * Edge middleware does read regular `process.env.*` at build/edge-deploy
 * time — that's the intended surface. We explicitly avoid leaking the
 * configured status to unauthenticated callers (no "bridge not configured"
 * hint in responses).
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  // crypto.subtle has no constant-time compare; do it manually.
  // Strings are opaque tokens from env, so length-leak is acceptable
  // (an attacker who can guess the exact length has already lost the game).
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isValidBridgeBearer(req: NextRequest): boolean {
  const configured = process.env.LAZYOS_VPS_BRIDGE_SECRET;
  if (!configured || configured.length < 16) return false;
  const header = req.headers.get("authorization");
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length).trim();
  if (!presented) return false;
  return timingSafeEqualStr(presented, configured);
}

/**
 * Agent/CLI Bearer gate (API-only).
 *
 * The `lazyos-cli` tool — which Claude Code invokes via Bash from within
 * a workspace session — authenticates to /api/* endpoints with:
 *
 *   Authorization: Bearer <LAZYOS_CLI_KEY>   (preferred, dedicated)
 *   Authorization: Bearer <LAZYOS_CHAT_KEY>  (fallback, same key the
 *                                             agent-server already uses)
 *
 * This intentionally does NOT grant access to HTML pages — only JSON API
 * routes. A session cookie is still required for UI, so a leaked CLI key
 * cannot open the browser shell.
 *
 * Both env vars default to empty; at least one must be set for CLI auth
 * to succeed. The minimum-length gate (16 chars) prevents accidentally
 * enabling "Bearer " + empty-string as a valid token.
 */
function isValidAgentBearer(req: NextRequest): boolean {
  const header = req.headers.get("authorization");
  if (!header) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length).trim();
  if (!presented || presented.length < 16) return false;

  const cliKey = process.env.LAZYOS_CLI_KEY ?? "";
  if (cliKey.length >= 16 && timingSafeEqualStr(presented, cliKey)) return true;

  const chatKey = process.env.LAZYOS_CHAT_KEY ?? "";
  if (chatKey.length >= 16 && timingSafeEqualStr(presented, chatKey)) return true;

  return false;
}

export const config = {
  // Exclude framework assets at the matcher level so Edge runs on
  // fewer requests. Everything else falls into the middleware body
  // which then whitelists by path.
  //
  // 2026-06-03 (HMR-Fix): wir schließen jetzt das GANZE `_next`-Präfix aus
  // (statt nur `_next/static|image|data`). Grund: der Turbopack-Dev-Runtime/
  // HMR-Pfad (`_next/webpack-hmr`, dev-Chunks) lief sonst durch die Middleware,
  // wurde auth-/rate-limit-behandelt und der isolierte Dev-Server (:4205)
  // hydratete nicht (localStorage leer, keine Client-Effekte). `_next/*` sind
  // ausschließlich Framework-Interna (Assets/Data/HMR) und brauchen weder Auth
  // noch Rate-Limit. PROD unberührt: dort erreichen praktisch keine `_next/*`-
  // Requests die Middleware (Assets sind statisch), das Verhalten für ALLE
  // App-/API-Routen bleibt identisch. Reversibel (alte Liste wiederherstellbar).
  matcher: [
    "/((?!_next|favicon.ico|icon.*\\.png|apple-touch-icon\\.png|manifest\\.webmanifest|sw\\.js|robots\\.txt|sitemap\\.xml).*)",
  ],
};

/** Public paths — no auth required. */
const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/welcome",
  "/design",
  "/whats-new",
  "/api/auth/login",
  "/api/auth/logout",
  // Phase ORG Magic-Link-Auth (2026-04-28 fix): issue+verify MÜSSEN public sein
  // sonst kann sich kein User per Email-Link einloggen. Eigene Rate-Limits +
  // Token-Single-Use-Schutz sind in den Routes.
  "/api/auth/magic/issue",
  "/api/auth/magic/verify",
  // Phase AU.1.3: Operator-Bootstrap-Endpoint. Nur für die fresh-installation,
  // gibt 410 sobald ein Founder existiert. Eigene timing-safe Compare in der Route.
  "/api/auth/bootstrap",
  // Phase AU.1.1: Status-Probe ob Operator-Bootstrap-UI angezeigt werden soll.
  "/api/auth/bootstrap-status",
  // 2026-04-28: Master-Code-Login für Solo-Self-Host (immer aktiv wenn Code gesetzt).
  "/api/auth/master-login",
  "/api/push/subscribe",
  "/api/push/send",
  "/api/push/notify-review",
  "/api/health",
  // 2026-05-23: Multi-Engine Adapter probe — read-only availability matrix,
  // same risk profile as /api/health.
  "/api/system/engines",
  // 2026-05-23 (Production-Hardening Agent 5/8): rich operator-dashboard
  // health endpoint (RSS, heap, broadcast depth, engine availability,
  // DB journal-mode). No secrets surfaced; safe to expose like /api/health.
  "/api/system/health",
  "/api/feedback",
  // Phase QA / MU.4: TPM-Status ist Diagnose-Read, kein Secret. Anonyme
  // Aufrufer sehen den shared-Scope; eingeloggte User mit own-Plan ihre
  // private Sicht (siehe currentUserIdResolved im Handler).
  "/api/quota/tpm-status",
  "/api/events/emit",
  "/api/heartbeat/tick",
  "/api/routines/tick",
  "/api/tickets/auto-advance",
]);

/** Prefixes that are public (startsWith). */
const PUBLIC_PREFIXES = [
  "/icon",
  "/apple-touch-icon",
  // Phase ORG+2 (2026-04-28): Share-Token-URLs sind Public-Read.
  // Auth wird im Route-Handler durch Token-Verify ersetzt.
  "/share/",
  "/api/share/",
  // Sub-Chats (2026-06-02, Gathering-Intelligence): externer Gast-Zugang via
  // Share-Token, KEIN Login. Auth = Token-Verify im Route-Handler
  // (resolveExternalToken). `/c/<token>` = externe Chat-Seite,
  // `/api/subchats/external/` = deren API.
  "/c/",
  "/api/subchats/external/",
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  for (const p of PUBLIC_PREFIXES) {
    if (pathname.startsWith(p)) return true;
  }
  return false;
}

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

/**
 * Kollabiert das per-Gast-Token-Segment öffentlicher Token-Routen für die
 * Rate-Limit-KEY, damit der Cap pro IP über ALLE Tokens hinweg greift (nicht
 * pro Token). `/api/subchats/external/<token>/upload` → `/api/subchats/external/
 * :token/upload`; `/share/<token>` → `/share/:token`. policyFor matcht den
 * Prefix weiterhin. Andere Pfade unverändert.
 */
function rateLimitKeyPath(pathname: string): string {
  let m = pathname.match(/^(\/api\/subchats\/external\/)[^/]+(\/.*)?$/);
  if (m) return `${m[1]}:token${m[2] ?? ""}`;
  m = pathname.match(/^(\/(?:api\/)?share\/)[^/]+(\/.*)?$/);
  if (m) return `${m[1]}:token${m[2] ?? ""}`;
  return pathname;
}

function ipOf(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function redirectToLogin(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  const from = req.nextUrl.pathname + req.nextUrl.search;
  url.pathname = "/login";
  url.search = `?from=${encodeURIComponent(from)}`;
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // --- 0. Unconditional inbound header strip (P0-#1 / F-1) ---
  // ANY identity/auth header the client sends MUST be neutralised before any
  // branch runs — including the public-path early-return.  Downstream code
  // (subject.ts, subject-server.ts) reads these headers as a trust anchor.
  // Only this middleware is allowed to SET them, and only after cryptographic
  // verification in branches 2b / 2c / 3 below.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.delete("x-lazyos-subject");
  requestHeaders.delete("x-lazyos-user-id");
  requestHeaders.delete("x-lazyos-auth");
  // P0-#1b / F-1b: same spoof class as the subject headers above, but these
  // feed the AUDIT/actor LABEL (not access-control). Bearer-authenticated
  // callers could otherwise write arbitrary identity labels into the audit
  // trail via these inbound headers (chat detectActor, ticket workflow
  // agentName, ticket products createdBy). Strip them unconditionally so the
  // routes fall back to the cryptographically verified subject.
  // NOTE: `x-lazyos-pending-id` is intentionally NOT stripped — it is a
  // legitimate, session-scoped SSE dedup hint, not an identity anchor;
  // stripping it would break stream recovery.
  requestHeaders.delete("x-lazyos-caller");
  requestHeaders.delete("x-lazyos-agent");
  requestHeaders.delete("x-lazyos-actor");

  // --- 1. Rate-limit (applies to EVERY request, including public ones) ---
  // Den per-Gast-Token aus dem Pfad für die Rate-Limit-KEY kollabieren
  // (Security-Review Finding #6): sonst wäre der strikte External-Cap PRO Token
  // statt pro IP → ein Angreifer mit vielen Tokens (oder x-forwarded-for-Spoof)
  // umginge ihn. Ein legitimer Gast nutzt genau EINEN Token → unverändert. Die
  // Prefix-Policy (policyFor) matcht den kollabierten Pfad weiterhin per prefix.
  const ip = ipOf(req);
  const rlPath = rateLimitKeyPath(pathname);
  const routeKey = `${method}:${rlPath}`;
  const policy = policyFor(method, rlPath);
  const rl = checkRateLimit(`${ip}:${routeKey}`, policy);
  if (!rl.allowed) {
    const body = JSON.stringify({
      error: "rate_limited",
      retryAfterSec: rl.retryAfterSec,
      limit: rl.limit,
    });
    return new NextResponse(body, {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(rl.retryAfterSec),
        "X-RateLimit-Limit": String(rl.limit),
        "X-RateLimit-Remaining": "0",
      },
    });
  }

  // --- 2. Public paths skip auth ---
  // Pass the stripped requestHeaders through so the handler sees no
  // client-supplied identity headers (was bare NextResponse.next() before).
  if (isPublicPath(pathname)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // --- 2b. VPS-Bridge service-to-service auth ---
  // Vercel-Edge forwards read requests to the VPS with a shared bearer.
  // If present and valid, treat as authenticated and mark the request so
  // downstream routes can distinguish (not strictly needed today, but
  // useful for audit).
  // Note: requestHeaders already has the identity headers deleted above;
  // we SET (never copy from inbound) to reflect verified identity.
  if (isValidBridgeBearer(req)) {
    requestHeaders.set("x-lazyos-subject", "system:bridge");
    requestHeaders.set("x-lazyos-auth", "bridge");
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set("x-lazyos-auth", "bridge");
    res.headers.set("X-RateLimit-Remaining", String(rl.remaining));
    return res;
  }

  // --- 2c. Agent/CLI bearer auth (API-only) ---
  // lazyos-cli (invoked by Claude Code via Bash) authenticates with
  // LAZYOS_CLI_KEY / LAZYOS_CHAT_KEY. We only honour this on /api/*
  // paths — HTML pages still require a session cookie so a leaked CLI
  // key cannot open the browser shell.
  // Note: requestHeaders already has the identity headers deleted above;
  // we SET (never copy from inbound) to reflect verified identity.
  if (isApiPath(pathname) && isValidAgentBearer(req)) {
    requestHeaders.set("x-lazyos-subject", "agent:cli");
    requestHeaders.set("x-lazyos-auth", "agent");
    const res = NextResponse.next({ request: { headers: requestHeaders } });
    res.headers.set("x-lazyos-auth", "agent");
    res.headers.set("X-RateLimit-Remaining", String(rl.remaining));
    return res;
  }

  // --- 3. Auth-check ---
  const sessionCfg = readSessionConfig();
  if (!sessionCfg) {
    // Server not yet configured. Rather than silently allow, we fail
    // closed — but give a clear marker so the operator knows why.
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { error: "server_not_configured", hint: "LAZYOS_ACCESS_CODE and LAZYOS_AUTH_SECRET must be set" },
        { status: 503 },
      );
    }
    return redirectToLogin(req);
  }

  const cookieValue = readSessionCookie(req.headers.get("cookie"));
  const verified = await verifySessionCookieValue(cookieValue, sessionCfg);

  if (!verified.ok) {
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { error: "unauthorized", reason: verified.reason ?? "unknown" },
        { status: 401 },
      );
    }
    return redirectToLogin(req);
  }

  // Attach a couple of marker headers downstream routes can inspect.
  // Verified session subject is propagated to handlers via request-header
  // (NOT response) so they can audit who acted without re-verifying.
  // Phase ORG (2026-04-27): userId aus dem verifizierten Cookie wird hier
  // als `x-lazyos-subject` durchgereicht. Legacy-Cookies (vor Phase ORG)
  // mappen auf BOOTSTRAP_USER_ID via session.ts — kein Force-Logout nötig.
  // Note: requestHeaders already has the identity headers deleted above;
  // we SET (never copy from inbound) to reflect the verified session.
  const userId = verified.userId ?? "max-bootstrap";
  requestHeaders.set("x-lazyos-subject", `user:${userId}`);
  requestHeaders.set("x-lazyos-user-id", userId);
  requestHeaders.set("x-lazyos-auth", "ok");

  // --- 4. OSS first-run gate (B0) ---
  // When LAZYOS_OSS_MODE is on and an authenticated browser session reaches an
  // HTML page that is not part of the wizard (or another bypass route), and the
  // `lazyos_onboarded` completion cookie is absent, redirect to /oss-onboarding.
  // Edge-cheap: cookie-only check, no DB access (the authoritative DB backstop
  // lives in app/page.tsx). API routes are never redirected so the wizard's own
  // /api/onboarding/* + /api/system/preflight calls keep working.
  if (
    isOssMode() &&
    !isApiPath(pathname) &&
    !isGateBypassPath(pathname) &&
    !hasOnboardedCookie(req.headers.get("cookie"))
  ) {
    const url = req.nextUrl.clone();
    url.pathname = "/oss-onboarding";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("x-lazyos-auth", "ok");
    redirect.headers.set("X-RateLimit-Remaining", String(rl.remaining));
    return redirect;
  }

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-lazyos-auth", "ok");
  res.headers.set("X-RateLimit-Remaining", String(rl.remaining));
  return res;
}
