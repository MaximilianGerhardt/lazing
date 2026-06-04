/**
 * VPS-Disk adapter — writes under `$LAZYOS_CLOUD_ROOT` or the default
 * `$HOME/.lazyos/cloud`. Only callable on the VPS instance (Vercel has
 * no persistent filesystem).
 *
 * Safety rails:
 *   - path-traversal protection: keys are validated against `..` and
 *     absolute paths. Every invalid key throws.
 *   - directories are created with `recursive: true` — missing
 *     parent folders are not an error.
 *   - on the Vercel runtime (`process.env.VERCEL === "1"`) the
 *     constructor throws immediately — no silent fail.
 */

import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

import {
  StorageBackend,
  StorageBackendError,
  StorageNotFoundError,
} from "./types";

const DEFAULT_ROOT = path.join(
  process.env.HOME ?? os.homedir(),
  ".lazyos",
  "cloud",
);

export class VpsDiskBackend implements StorageBackend {
  readonly root: string;

  constructor(root?: string) {
    if (process.env.VERCEL === "1") {
      throw new StorageBackendError(
        "VpsDiskBackend cannot run on Vercel — kein persistentes Filesystem. " +
          "Cloud-Routen müssen entweder auf der VPS-Instanz laufen oder via " +
          "VPS-Bridge geproxied werden.",
      );
    }
    this.root = root ?? process.env.LAZYOS_CLOUD_ROOT ?? DEFAULT_ROOT;
  }

  /**
   * Validates the key against path traversal with a segment walk.
   * First defense: token-by-token check (NUL, backslash, ..).
   * Second defense: the resolved path must stay under root.
   */
  private resolveKey(key: string): string {
    if (!key || key.length === 0) {
      throw new StorageBackendError("storage key must not be empty");
    }
    if (key.includes("\0")) {
      throw new StorageBackendError("storage key contains NUL byte");
    }
    if (path.isAbsolute(key)) {
      throw new StorageBackendError(`unsafe storage key (absolute): ${key}`);
    }
    const segments = key.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) {
      throw new StorageBackendError("storage key empty after segment-split");
    }
    for (const s of segments) {
      if (s === "." || s === "..") {
        throw new StorageBackendError(`unsafe storage segment: ${s}`);
      }
      if (s.includes("\\") || s.includes("\0")) {
        throw new StorageBackendError(`unsafe storage segment chars: ${s}`);
      }
    }
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep) && full !== this.root) {
      throw new StorageBackendError(`storage key escapes root: ${key}`);
    }
    return full;
  }

  private async ensureDirFor(fullPath: string): Promise<void> {
    await mkdir(path.dirname(fullPath), { recursive: true });
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolveKey(key);
    await this.ensureDirFor(full);
    await writeFile(full, data);
  }

  async putStream(key: string, data: Readable): Promise<void> {
    const full = this.resolveKey(key);
    await this.ensureDirFor(full);
    const ws = createWriteStream(full);
    await pipeline(data, ws);
  }

  async get(key: string): Promise<Buffer> {
    const full = this.resolveKey(key);
    if (!existsSync(full)) throw new StorageNotFoundError(key);
    return readFile(full);
  }

  async getStream(key: string): Promise<Readable> {
    const full = this.resolveKey(key);
    if (!existsSync(full)) throw new StorageNotFoundError(key);
    return createReadStream(full);
  }

  async delete(key: string): Promise<void> {
    const full = this.resolveKey(key);
    await rm(full, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const full = this.resolveKey(key);
      return existsSync(full) && statSync(full).isFile();
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const full = this.resolveKey(key);
    if (!existsSync(full)) throw new StorageNotFoundError(key);
    const s = await stat(full);
    return s.size;
  }

  /**
   * Absolute path for `key` (path-traversal-validated via resolveKey).
   * Used for the agent prompt (`[Angehängt: <abs-path>]`).
   */
  absolutePath(key: string): string {
    return this.resolveKey(key);
  }
}
