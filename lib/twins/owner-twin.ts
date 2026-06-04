/**
 * Pattern 2 Digital-Twin MVP — owner twin-Loader.
 *
 * Lädt `data/owner_twin.yaml` einmal, cached module-scope, invalidiert
 * automatisch wenn sich das File-mtime ändert (mtime-Check pro Call,
 * stat ist <0,1ms — wir sparen uns chokidar als Dep).
 *
 * Fail-soft: bei Schema-Validation-Error wird der bestehende Cache
 * behalten und ein Warn geloggt. Kein Twin-Lookup darf jemals
 * tier-spawn blockieren.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import yaml from "yaml";

import { MaxTwinSchema, type OwnerTwin } from "./types";

const TWIN_PATH = path.resolve(
  process.cwd(),
  "data",
  "owner_twin.yaml",
);

interface Cache {
  twin: OwnerTwin;
  mtimeMs: number;
}

let cache: Cache | null = null;

async function load(): Promise<OwnerTwin | null> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(TWIN_PATH);
  } catch {
    // File fehlt komplett — graceful: leerer Twin.
    return null;
  }

  if (cache && cache.mtimeMs === stat.mtimeMs) {
    return cache.twin;
  }

  let raw: string;
  try {
    raw = await fs.readFile(TWIN_PATH, "utf8");
  } catch (err) {
    if (cache) {
      console.warn("[owner twin] read failed, keeping cache:", err);
      return cache.twin;
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(raw);
  } catch (err) {
    if (cache) {
      console.warn("[owner twin] yaml parse failed, keeping cache:", err);
      return cache.twin;
    }
    console.warn("[owner twin] yaml parse failed, no prior cache:", err);
    return null;
  }

  const result = MaxTwinSchema.safeParse(parsed);
  if (!result.success) {
    if (cache) {
      console.warn(
        "[owner twin] schema validation failed, keeping cache:",
        result.error.issues,
      );
      return cache.twin;
    }
    console.warn(
      "[owner twin] schema validation failed, no prior cache:",
      result.error.issues,
    );
    return null;
  }

  cache = { twin: result.data, mtimeMs: stat.mtimeMs };
  return cache.twin;
}

/**
 * Liefert den aktuellen owner twin (oder null bei fehlendem/ungültigem File).
 * Cache-Invalidierung via mtime — Edits an `data/owner_twin.yaml` werden
 * beim nächsten Call automatisch eingelesen.
 */
export async function getOwnerTwin(): Promise<OwnerTwin | null> {
  return load();
}

/**
 * Test-Hook: Cache leeren, damit Tests einen frischen Load erzwingen
 * können nach yaml-Datei-Änderung.
 */
export function clearOwnerTwinCache(): void {
  cache = null;
}
