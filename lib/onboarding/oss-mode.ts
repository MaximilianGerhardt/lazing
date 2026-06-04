/**
 * OSS first-run mode flag + onboarded-cookie name (Track B, B0).
 *
 * `LAZYOS_OSS_MODE=true` turns on the first-run gate: HTML pages are
 * redirected to `/oss-onboarding` until the wizard completes. The completion
 * marker is twofold and defence-in-depth:
 *
 *   1. The Edge middleware reads the `lazyos_onboarded` cookie (cheap, no DB
 *      access — Edge runtime cannot touch better-sqlite3). The cookie is set
 *      by the finalize step.
 *   2. The Node-side `app/page.tsx` checks `oss_onboarding_completed_at` in the
 *      DB as the authoritative backstop (covers a cleared cookie / new browser).
 *
 * This module is Edge-safe: it only reads `process.env` and exports pure
 * helpers — no node:* imports.
 */

/** Cookie set on wizard completion; absence => treat as "not yet onboarded". */
export const ONBOARDED_COOKIE = "lazyos_onboarded";

/** Truthy env values that enable OSS first-run mode. */
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/** Whether OSS first-run mode is enabled via `LAZYOS_OSS_MODE`. */
export function isOssMode(): boolean {
  const raw = (process.env.LAZYOS_OSS_MODE ?? "").trim().toLowerCase();
  return TRUE_VALUES.has(raw);
}

/**
 * Parse a `Cookie` header and return whether the onboarded marker is present.
 * Edge-safe (string parsing only).
 */
export function hasOnboardedCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${ONBOARDED_COOKIE}=`)) {
      const value = trimmed.slice(ONBOARDED_COOKIE.length + 1);
      return value === "1" || value === "true";
    }
  }
  return false;
}

/**
 * Build a `Set-Cookie` header value marking the user as onboarded.
 * 1-year max-age, HttpOnly, SameSite=Lax, path=/. `secure` is opt-in via the
 * argument so localhost HTTP setup still works.
 */
export function buildOnboardedCookie(opts: { secure?: boolean } = {}): string {
  const parts = [
    `${ONBOARDED_COOKIE}=1`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 365}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * HTML page paths that must stay reachable WITHOUT redirecting to the wizard,
 * so the first-run gate does not trap the user (the wizard itself, login,
 * the public design/welcome routes). API paths are handled separately —
 * they are never redirected by the gate.
 */
const GATE_BYPASS_PREFIXES = [
  "/oss-onboarding",
  "/login",
  "/welcome",
  "/design",
  "/whats-new",
  "/c/", // external guest sub-chat
  "/share/", // public share-token pages
];

/** Whether a page path bypasses the first-run gate. */
export function isGateBypassPath(pathname: string): boolean {
  if (pathname === "/oss-onboarding") return true;
  return GATE_BYPASS_PREFIXES.some((p) => pathname.startsWith(p));
}
