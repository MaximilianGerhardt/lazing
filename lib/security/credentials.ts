/**
 * Workspace-Credentials encryption (Phase 2026-04-25, User-Feedback).
 *
 * Single-user PWA — we encrypt credentials with AES-256-GCM. The
 * key comes from env LAZYOS_CREDENTIAL_KEY (32 bytes, hex). Without a
 * key, nothing can be stored — fail-closed.
 *
 * On-disk format:
 *   "<iv-hex>:<ciphertext-hex>:<authtag-hex>"
 *
 * - iv: 12 bytes random per value (GCM recommendation)
 * - ciphertext: variable (same length as plaintext)
 * - authtag: 16 bytes GCM-MAC for integrity
 *
 * Decrypt throws if the DB file was tampered with (authtag mismatch).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = (process.env.LAZYOS_CREDENTIAL_KEY ?? '').trim();
  if (!raw) {
    throw new Error('LAZYOS_CREDENTIAL_KEY ist nicht gesetzt');
  }
  // Accept hex (64 chars) or base64 (44 chars)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex');
  } else if (raw.length === 44) {
    cachedKey = Buffer.from(raw, 'base64');
  } else {
    throw new Error(
      'LAZYOS_CREDENTIAL_KEY muss 64 hex chars (32 bytes) oder 44 base64 chars sein',
    );
  }
  if (cachedKey.length !== KEY_BYTES) {
    cachedKey = null;
    throw new Error(`LAZYOS_CREDENTIAL_KEY hat falsche Laenge (erwartet ${KEY_BYTES} bytes)`);
  }
  return cachedKey;
}

export function encryptCredential(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptCredential(stored: string): string {
  const key = getKey();
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('credential ciphertext malformed');
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/** Render-only preview of an encrypted value. Never send the
 *  plaintext to the frontend in listings — only a masked
 *  hint with the length.
 *
 *  Security-Critic 1a (2026-05-24): no more plaintext PREFIX. Before, the
 *  first 2 + last 2 plaintext characters were shown (for len<=4 even the
 *  full plaintext). That effectively leaked the whole value for short secrets
 *  and the first 2 characters for every secret — enough for provider
 *  fingerprinting / brute-force shortening.
 *
 *  New rule (strictly less plaintext than before, never more):
 *   - len === 0       → '' (empty).
 *   - len <= 8 (short) → FULLY masked: '••••••••(n)'. NO plaintext.
 *   - len  > 8 (long)  → only the LAST 2 characters visible: '••••••••cd (n)'.
 *                       NO prefix anymore.
 *
 *  The return stays a string — no caller breaks (pure security
 *  improvement). Existing callers: GitHub listings, workspace-credentials
 *  listing, connectors/invoke previewCall, ACL5-B credential-route response. */
export function maskedPreview(plaintext: string): string {
  const len = plaintext.length;
  if (len === 0) return '';
  // Short secrets (<=8): FULLY masked, only the length is revealed.
  if (len <= 8) {
    return '•'.repeat(8) + `(${len})`;
  }
  // Long secrets: at most the last 2 characters, NO prefix.
  return '•'.repeat(8) + plaintext.slice(-2) + ` (${len})`;
}

export function newCredentialId(): string {
  return `cred-${randomUUID()}`;
}
