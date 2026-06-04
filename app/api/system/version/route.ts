/**
 * GET /api/system/version
 *
 * Reports the locally installed version and, best-effort, whether a newer
 * release exists upstream (GitHub latest release/tag). Used by the in-app
 * "update available" hint and by `scripts/lazyos-update.sh` consumers.
 *
 * Fail-soft: if the upstream check is unavailable (offline, rate-limited), the
 * local version is still returned with `updateAvailable: null`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO = process.env.LAZYOS_UPDATE_REPO ?? "MaximilianGerhardt/lazing";

function localVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Compare semver-ish strings; returns true if `remote` is strictly newer. */
function isNewer(remote: string, local: string): boolean {
  const norm = (s: string) =>
    s.replace(/^v/, "").split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const r = norm(remote);
  const l = norm(local);
  for (let i = 0; i < Math.max(r.length, l.length); i += 1) {
    const a = r[i] ?? 0;
    const b = l[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export async function GET(): Promise<Response> {
  const version = localVersion();

  let latest: string | null = null;
  let updateAvailable: boolean | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "lazyos" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: string };
      if (typeof body.tag_name === "string" && body.tag_name) {
        latest = body.tag_name;
        updateAvailable = isNewer(latest, version);
      }
    }
  } catch {
    /* offline / rate-limited → updateAvailable stays null */
  }

  return NextResponse.json({ version, latest, updateAvailable, repo: REPO });
}
