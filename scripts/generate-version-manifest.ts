#!/usr/bin/env -S node --import=tsx
/**
 * Build-Time-Generator fuer das lazyOS Versions-Manifest.
 *
 * Schreibt zwei Outputs:
 *   1. `public/version.json` — statisches Asset, vom Service-Worker
 *      explizit bypassed; vom Browser per fetch('/version.json') lesbar.
 *   2. `lib/diagnostics/build-info.generated.ts` — typsicher importierbar
 *      vom Server (z.B. /api/version, /api/diagnostics) ohne FS-Read.
 *
 * Tupel:
 *   {
 *     commitSha:           full SHA, "unknown" wenn kein Git-Tree
 *     shortSha:            7-char prefix
 *     buildId:             SHORT_SHA + "-" + epoch-seconds (eindeutig)
 *     buildTime:           ISO-8601 UTC
 *     schemaHash:          sha256(gemerged-Inhalt aller db/schema/*.ts), 16 hex
 *     swVersion:           VERSION-Konstante aus public/sw.js geparst
 *     nodeVersion:         process.version
 *     vercelDeploymentId:  process.env.VERCEL_DEPLOYMENT_ID || null
 *     vercelEnv:           process.env.VERCEL_ENV || "local"
 *     treeDirty:           true wenn `git status --porcelain` etwas zeigt
 *   }
 *
 * Aufruf:
 *   - Automatisch via `pnpm prebuild` (siehe package.json)
 *   - Manuell:  pnpm tsx scripts/generate-version-manifest.ts
 *
 * Idempotent — sicher auch bei jedem `next dev`-Boot ausfuehrbar.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const PUBLIC_OUT = path.join(REPO_ROOT, "public", "version.json");
const TS_OUT = path.join(REPO_ROOT, "lib", "diagnostics", "build-info.generated.ts");
const SCHEMA_DIR = path.join(REPO_ROOT, "db", "schema");
const SW_PATH = path.join(REPO_ROOT, "public", "sw.js");

interface VersionManifest {
  commitSha: string;
  shortSha: string;
  buildId: string;
  buildTime: string;
  schemaHash: string;
  swVersion: string;
  nodeVersion: string;
  vercelDeploymentId: string | null;
  vercelEnv: string;
  treeDirty: boolean;
}

function tryGit(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveCommitSha(): { full: string; short: string } {
  // Vercel-Build setzt VERCEL_GIT_COMMIT_SHA — bevorzugt, falls Tree
  // ohne `.git`-Verzeichnis gebuildet wird (Vercel shallow checkout).
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv && fromEnv.length >= 7) {
    return { full: fromEnv, short: fromEnv.slice(0, 7) };
  }
  const full = tryGit(["rev-parse", "HEAD"]);
  if (full) return { full, short: full.slice(0, 7) };
  return { full: "unknown", short: "unknown" };
}

function resolveTreeDirty(): boolean {
  const out = tryGit(["status", "--porcelain"]);
  if (out === null) return false;
  return out.length > 0;
}

/**
 * Haengt einen stabilen Hash ueber db/schema/**.ts an. Reihenfolge ist
 * deterministisch (sortiert), Whitespace bleibt 1:1 — Drift-Detection
 * erkennt also auch "Spalten-Reorder ohne Datenbank-Effekt", nicht nur
 * struktur-relevante Aenderungen. Das ist gewollt: bei Mismatch wollen
 * wir _wissen_ dass irgendwer das Schema angefasst hat.
 */
function computeSchemaHash(): string {
  if (!existsSync(SCHEMA_DIR)) return "no-schema";
  const files = readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
  const hash = createHash("sha256");
  for (const f of files) {
    const full = path.join(SCHEMA_DIR, f);
    const st = statSync(full);
    if (!st.isFile()) continue;
    hash.update(`---FILE:${f}---\n`);
    hash.update(readFileSync(full));
  }
  return hash.digest("hex").slice(0, 16);
}

/** Liest `const VERSION = "..."` aus `public/sw.js`. */
function resolveSwVersion(): string {
  if (!existsSync(SW_PATH)) return "no-sw";
  const src = readFileSync(SW_PATH, "utf8");
  const m = /const\s+VERSION\s*=\s*["']([^"']+)["']/.exec(src);
  return m?.[1] ?? "unknown";
}

function buildManifest(): VersionManifest {
  const { full: commitSha, short: shortSha } = resolveCommitSha();
  const buildTimeMs = Date.now();
  const buildTime = new Date(buildTimeMs).toISOString();
  const buildId = `${shortSha}-${Math.floor(buildTimeMs / 1000)}`;

  return {
    commitSha,
    shortSha,
    buildId,
    buildTime,
    schemaHash: computeSchemaHash(),
    swVersion: resolveSwVersion(),
    nodeVersion: process.version,
    vercelDeploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? "local",
    treeDirty: resolveTreeDirty(),
  };
}

function writeOutputs(manifest: VersionManifest): void {
  // public/version.json — JSON, wird statisch ausgeliefert.
  mkdirSync(path.dirname(PUBLIC_OUT), { recursive: true });
  writeFileSync(PUBLIC_OUT, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // lib/diagnostics/build-info.generated.ts — typed import.
  mkdirSync(path.dirname(TS_OUT), { recursive: true });
  const ts = `// AUTO-GENERATED by scripts/generate-version-manifest.ts
// Do not edit by hand. Re-run \`pnpm tsx scripts/generate-version-manifest.ts\`.

import type { VersionManifest } from "./types";

export const BUILD_INFO: VersionManifest = ${JSON.stringify(manifest, null, 2)} as const;
`;
  writeFileSync(TS_OUT, ts, "utf8");
}

function main(): void {
  const manifest = buildManifest();
  writeOutputs(manifest);
  // eslint-disable-next-line no-console
  console.log(
    `[version-manifest] sha=${manifest.shortSha} build=${manifest.buildId} schema=${manifest.schemaHash} dirty=${manifest.treeDirty}`,
  );
}

main();
