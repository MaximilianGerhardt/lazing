/**
 * Storage-backend abstraction for the workspace cloud.
 *
 * Day-1: VPS-Disk adapter (local filesystem under $HOME/.lazyos/cloud).
 * Day-N: S3 adapter — same interface, strategy pattern.
 *
 * Encryption is NOT part of this layer in Phase 1 (encryptionVersion=0
 * in the DB). Phase 2 wraps the adapter with an AES-256-GCM EncryptingAdapter.
 *
 * Key format (convention):
 *   <workspaceId>/<artifactId>            ← file content
 *   <workspaceId>/_thumbs/<artifactId>.png ← thumbnail
 *
 * No slashes in the artifactId itself — this is guaranteed by the ULID format.
 */

import type { Readable } from "node:stream";

export interface StorageBackend {
  /** Writes a buffer at `key`. Overwrites if present. */
  put(key: string, data: Buffer): Promise<void>;

  /** Streaming variant for large files (upload streams). */
  putStream(key: string, data: Readable): Promise<void>;

  /** Reads fully into memory. Only for small files (thumbs, metadata). */
  get(key: string): Promise<Buffer>;

  /** Streaming read for the download endpoint. */
  getStream(key: string): Promise<Readable>;

  /** Deletes. Idempotent — no throw if the key is missing. */
  delete(key: string): Promise<void>;

  /** Existence check without read. */
  exists(key: string): Promise<boolean>;

  /** Byte size; throws if not present. */
  size(key: string): Promise<number>;

  /**
   * Absolute filesystem path for `key`, if the backend has one
   * (VPS-Disk: yes; S3: undefined). Needed for the agent prompt, so that
   * an uploaded file can be referenced as `[Angehängt: <abs-path>]`
   * and used by the agent via Read/Vision. Optional — the caller
   * must tolerate `undefined`.
   */
  absolutePath?(key: string): string;
}

export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`storage key not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

export class StorageBackendError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "StorageBackendError";
  }
}
