/**
 * Pattern 2 Digital-Twin MVP — owner-twin loader.
 *
 * Loads `data/owner_twin.yaml` once, cached module-scope, invalidates
 * automatically when the file mtime changes (mtime check per call,
 * stat is <0.1ms — we save ourselves chokidar as a dep).
 *
 * Fail-soft: on a schema validation error, the existing cache is
 * kept and a warning is logged. No twin lookup may ever
 * block tier-spawn.
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
    // File is missing entirely — graceful: empty twin.
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
 * Returns the current owner twin (or null on a missing/invalid file).
 * Cache invalidation via mtime — edits to `data/owner_twin.yaml` are
 * read in automatically on the next call.
 */
export async function getOwnerTwin(): Promise<OwnerTwin | null> {
  return load();
}

/**
 * Test hook: clear the cache so tests can force a fresh load
 * after a yaml-file change.
 */
export function clearOwnerTwinCache(): void {
  cache = null;
}
