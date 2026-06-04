/**
 * AES-256-GCM Encrypt/Decrypt-Helpers (Phase ORG+1).
 *
 * File-Format:
 *   [12 bytes nonce][16 bytes auth-tag][N bytes ciphertext]
 *
 * Nonce: random per encrypt — never reuse for the same key.
 * With AES-GCM, nonce reuse is fatal (stream XOR + auth bypass).
 *
 * Wrap/unwrap DEK: same routine, different key (KEK instead of DEK).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;

export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptError";
  }
}

/**
 * Encrypt mit AES-256-GCM.
 * @param key 32-byte Buffer
 * @param plaintext beliebig lang
 * @returns Buffer im Format [nonce|tag|ciphertext]
 */
export function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`AES-256-GCM key must be 32 bytes, got ${key.length}`);
  }
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]);
}

/**
 * Decrypt — throws DecryptError on auth-tag failure (tampering or wrong key).
 */
export function aesGcmDecrypt(key: Buffer, framed: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`AES-256-GCM key must be 32 bytes, got ${key.length}`);
  }
  if (framed.length < NONCE_LEN + TAG_LEN) {
    throw new DecryptError("framed input too short");
  }
  const nonce = framed.subarray(0, NONCE_LEN);
  const tag = framed.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ciphertext = framed.subarray(NONCE_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new DecryptError(
      err instanceof Error ? err.message : "auth-tag-mismatch",
    );
  }
}

/** Generate a fresh random 32-byte DEK. */
export function newDek(): Buffer {
  return randomBytes(32);
}
