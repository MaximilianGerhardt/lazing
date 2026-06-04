/**
 * Master-KEK-Resolver (Phase ORG+1).
 *
 * Reads `LAZYOS_MASTER_KEK` from env — 64 hex chars (= 32 bytes / 256 bits).
 * If unset: the encryption stack is unavailable — the sensitivity floor
 * stays blocked for sensitivity='high' workspaces.
 *
 * KEK rotation: SP-N (Phase ORG+2). Heute statisch v1.
 */

const KEK_HEX_LEN = 64; // 32 bytes

export interface MasterKey {
  /** 32-byte buffer holding the plaintext KEK. */
  buffer: Buffer;
  /** Static v1 for Phase ORG+1. */
  version: 1;
}

let cached: MasterKey | null = null;

export function getMasterKey(): MasterKey | null {
  if (cached) return cached;
  const raw = process.env.LAZYOS_MASTER_KEK?.trim();
  if (!raw) return null;
  if (raw.length !== KEK_HEX_LEN) {
    console.warn(
      `[encryption] LAZYOS_MASTER_KEK has wrong length ${raw.length} (expected ${KEK_HEX_LEN}). Encryption disabled.`,
    );
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    console.warn("[encryption] LAZYOS_MASTER_KEK is not hex. Encryption disabled.");
    return null;
  }
  cached = {
    buffer: Buffer.from(raw, "hex"),
    version: 1,
  };
  return cached;
}

export function isEncryptionAvailable(): boolean {
  return getMasterKey() !== null;
}

/** Test-Helper. */
export function _resetMasterKeyCacheForTests(): void {
  cached = null;
}
