/**
 * Storage factory — selects the backend based on runtime.
 *
 * Currently only one backend (VPS-Disk). Day N: S3/MinIO via strategy
 * pattern — same `StorageBackend` interface, only the selection logic is
 * extended here.
 */

import { isEncryptionAvailable } from "@/lib/encryption/master-key";

import type { StorageBackend } from "./types";
import { EncryptingStorageBackend } from "./encrypting";
import { VpsDiskBackend } from "./vps-disk";

let cachedBackend: StorageBackend | null = null;
let cachedRawBackend: StorageBackend | null = null;

/**
 * Default backend: VPS-Disk only (no encrypting wrapper). Used for
 * unencrypted workspaces (sensitivity != 'high').
 */
export function getStorageBackend(): StorageBackend {
  if (cachedBackend) return cachedBackend;
  cachedBackend = new VpsDiskBackend();
  return cachedBackend;
}

/**
 * Encrypted backend for sensitive workspaces. Throws when the master KEK
 * is missing (caller MUST check via `isEncryptionAvailable()` beforehand).
 */
export function getEncryptedStorageBackend(): StorageBackend {
  if (!isEncryptionAvailable()) {
    throw new Error(
      "encryption-not-configured: LAZYOS_MASTER_KEK env muss gesetzt sein für sensitivity=high Workspaces",
    );
  }
  if (!cachedRawBackend) cachedRawBackend = new VpsDiskBackend();
  return new EncryptingStorageBackend(cachedRawBackend);
}

/** Test-Helper. */
export function setStorageBackendForTests(backend: StorageBackend | null): void {
  cachedBackend = backend;
}

export type { StorageBackend } from "./types";
export { StorageNotFoundError, StorageBackendError } from "./types";
