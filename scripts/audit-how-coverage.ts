#!/usr/bin/env tsx
/**
 * /how Coverage-Audit (Task #31).
 *
 * Scannt die Codebase nach erstklassigen Konzepten und prüft ob jedes davon
 * in /how dokumentiert ist. Output zeigt:
 *   [+] dokumentiert  → /how/<slug> existiert
 *   [-] fehlend       → Konzept in Code aber kein /how-Slug
 *   [?] verwaist      → /how-Slug aber kein Code-Konzept (manuell prüfen)
 *
 * Das ersetzt **kein** richtiges Auto-Update — der Inhalt der Sub-Pages bleibt
 * handgeschrieben. Aber so wissen wir vor jedem Release was fehlt.
 *
 * Aufruf:
 *   pnpm tsx scripts/audit-how-coverage.ts
 *   pnpm tsx scripts/audit-how-coverage.ts --json    # für CI
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { SLUGS } from "../lib/how/content";

interface CoverageReport {
  routes: { covered: string[]; missing: string[] };
  surfaceKinds: { covered: string[]; missing: string[] };
  orphanedSlugs: string[];
}

const ROUTE_TO_SLUG: Record<string, string> = {
  "/workstreams": "workstreams",
  "/tickets": "tickets",
  "/sessions": "sessions",
  "/routines": "routines",
  "/skills": "skills",
  "/workspaces": "workspaces",
  "/orgs": "organizations",
  "/login": "auth",
  "/onboarding": "auth",
  "/inbox": "inbox",
};

/** Scan-Result: alle App-Routes (außer api/ + dynamic). */
function listAppRoutes(): string[] {
  const root = path.join(process.cwd(), "app");
  const out: string[] = [];
  function walk(dir: string, prefix: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (e === "api" || e === "_components" || e.startsWith("_")) continue;
      // dynamic segments [id] → skip from coverage
      const segment = e.startsWith("[") ? null : e;
      const newPrefix = segment ? `${prefix}/${segment}` : prefix;
      // Has page.tsx?
      try {
        statSync(path.join(full, "page.tsx"));
        if (segment !== null) out.push(newPrefix || "/");
      } catch {
        /* no page.tsx */
      }
      walk(full, newPrefix);
    }
  }
  walk(root, "");
  return Array.from(new Set(out)).sort();
}

/** Liest Surface-Kinds aus lib/chat/surface-parser.ts. */
function listSurfaceKinds(): string[] {
  try {
    const p = path.join(process.cwd(), "lib", "chat", "surface-parser.ts");
    const src = readFileSync(p, "utf8");
    const m = src.match(/SURFACE_KINDS\s*=\s*\[([^\]]+)\]/);
    if (!m) return [];
    return Array.from(m[1].matchAll(/['"]([a-z0-9-]+)['"]/gi)).map(
      (mm) => mm[1],
    );
  } catch {
    return [];
  }
}

function buildReport(): CoverageReport {
  const slugs = new Set(SLUGS);
  const routes = listAppRoutes();
  const knownRouteSlugs = new Set(Object.values(ROUTE_TO_SLUG));

  const routesCovered: string[] = [];
  const routesMissing: string[] = [];
  for (const route of routes) {
    const slug = ROUTE_TO_SLUG[route];
    if (slug && slugs.has(slug)) {
      routesCovered.push(`${route} → /how/${slug}`);
    } else if (slug && !slugs.has(slug)) {
      routesMissing.push(`${route} → /how/${slug} (slug fehlt)`);
    } else {
      routesMissing.push(`${route} (kein Mapping in audit-how-coverage.ts)`);
    }
  }

  // Surface-Kinds gegen /how check (nur informativ — viele Kinds haben keine
  // eigene Sub-Page, das ist OK).
  const kinds = listSurfaceKinds();
  const surfaceCovered: string[] = [];
  const surfaceMissing: string[] = [];
  for (const k of kinds) {
    if (slugs.has(k)) surfaceCovered.push(k);
    else surfaceMissing.push(k);
  }

  // Verwaiste Slugs (existieren in /how aber kein bekannter Code-Anchor)
  const orphaned = SLUGS.filter(
    (s) => !knownRouteSlugs.has(s) && !kinds.includes(s),
  );

  return {
    routes: { covered: routesCovered, missing: routesMissing },
    surfaceKinds: { covered: surfaceCovered, missing: surfaceMissing },
    orphanedSlugs: orphaned,
  };
}

function main(): void {
  const json = process.argv.includes("--json");
  const report = buildReport();

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("=== /how Coverage Audit ===\n");

  console.log("Routes:");
  for (const r of report.routes.covered) console.log(`  [+] ${r}`);
  for (const r of report.routes.missing) console.log(`  [-] ${r}`);
  console.log("");

  console.log("Surface-Kinds (nur informativ — nicht alle brauchen /how):");
  console.log(
    `  [+] dokumentiert: ${report.surfaceKinds.covered.join(", ") || "—"}`,
  );
  console.log(
    `  [.] keine Sub-Page: ${report.surfaceKinds.missing.length} Kind(s)`,
  );
  console.log("");

  if (report.orphanedSlugs.length > 0) {
    console.log("Verwaiste /how-Slugs (kein Code-Anchor — manuell prüfen):");
    for (const s of report.orphanedSlugs) console.log(`  [?] ${s}`);
  } else {
    console.log("Keine verwaisten /how-Slugs.");
  }

  const hasMissing = report.routes.missing.length > 0;
  console.log(
    `\nResult: ${hasMissing ? "MISSING" : "OK"} · ${report.routes.covered.length} routes covered, ${report.routes.missing.length} missing.`,
  );
  if (hasMissing) process.exit(2);
}

main();
