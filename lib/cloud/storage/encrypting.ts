/**
 * EncryptingStorageBackend (Phase ORG+1 — 2026-04-28).
 *
 * Wrapper adapter over an inner backend (today VPS-Disk). On
 * write: AES-256-GCM with the per-workspace DEK. On read: decrypt.
 *
 * Heuristic for where the workspace comes from in the key: the first path
 * segment of the storage key (convention `<workspaceId>/<artifactId>`). Phase-N:
 * via a dedicated metadata layer instead of a convention.
 *
 * encryption_version=1 is set by the service layer in the DB row; here
 * it is only the bytes path.
 */

import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";

import { aesGcmDecrypt, aesGcmEncrypt } from "@/lib/encryption/aes-gcm";
import { getWorkspaceDek } from "@/lib/encryption/key-vault";

import type { StorageBackend } from "./types";

/** Erstes Path-Segment = workspaceId. */
function deriveWorkspaceFromKey(key: string): string {
  const slash = key.indexOf("/");
  if (slash <= 0) {
    throw new Error(
      `EncryptingStorageBackend: cannot derive workspace from key '${key}' — expected '<workspace>/<id>...'`,
    );
  }
  return key.slice(0, slash);
}

export class EncryptingStorageBackend implements StorageBackend {
  constructor(private readonly inner: StorageBackend) {}

  async put(key: string, data: Buffer): Promise<void> {
    const dek = getWorkspaceDek(deriveWorkspaceFromKey(key));
    const ct = aesGcmEncrypt(dek, data);
    await this.inner.put(key, ct);
  }

  async putStream(key: string, data: Readable): Promise<void> {
    // Phase-1: stream → buffer → encrypt → put. For large files this
    // is memory-heavy; Phase-N: streaming AES via Node streams +
    // block-by-block GCM (complex). The 50 MB hard cap is already
    // enforced at the API layer.
    const chunks: Buffer[] = [];
    for await (const chunk of data) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    await this.put(key, buf);
  }

  async get(key: string): Promise<Buffer> {
    const dek = getWorkspaceDek(deriveWorkspaceFromKey(key));
    const ct = await this.inner.get(key);
    return aesGcmDecrypt(dek, ct);
  }

  async getStream(key: string): Promise<Readable> {
    // Buffer it for AES-GCM (the auth tag must be verified as a whole
    // against the bytes block before we can stream safely).
    const plain = await this.get(key);
    return NodeReadable.from(plain);
  }

  async delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }

  async size(key: string): Promise<number> {
    // Encrypted size = plain + 12 nonce + 16 tag = +28 bytes. The caller
    // should not compare size() ↔ bytes when encryption_version>=1.
    return this.inner.size(key);
  }
}
