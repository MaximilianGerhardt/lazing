/**
 * ULID — Universally Unique Lexicographically Sortable Identifier.
 *
 * Crockford-Base32, 26 chars total:
 *   - 10 chars: timestamp (ms epoch, 48 bits)
 *   - 16 chars: randomness (80 bits)
 *
 * Monotonic: when called within the same ms, we increment the random bucket
 * instead of regenerating so IDs remain strictly sortable.
 *
 * Reference: https://github.com/ulid/spec
 *
 * No npm dependency — zero-trust, ~60 lines.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = 0;
let lastRandom: Uint8Array = new Uint8Array(new ArrayBuffer(RANDOM_LEN));

function encodeTime(now: number): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(`ULID: invalid time ${now}`);
  }
  let mod = now;
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const r = mod % ENCODING_LEN;
    out = ENCODING[r] + out;
    mod = (mod - r) / ENCODING_LEN;
  }
  return out;
}

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(new ArrayBuffer(len));
  // Browser + Node >=16 both expose globalThis.crypto.getRandomValues.
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
    return buf;
  }
  // Fallback — should never hit in modern runtimes.
  for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

function encodeRandom(bytes: Uint8Array): string {
  // Map each byte into Base32 — we use bytes % 32 which is fine for uniform random bytes.
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[bytes[i] % ENCODING_LEN];
  }
  return out;
}

/**
 * Generate a monotonic ULID. If called multiple times in the same ms,
 * the random bucket is incremented so the result strictly sorts after the
 * previous one.
 */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // Increment lastRandom as a big-endian integer.
    for (let i = RANDOM_LEN - 1; i >= 0; i--) {
      lastRandom[i] = (lastRandom[i] + 1) & 0xff;
      if (lastRandom[i] !== 0) break;
    }
  } else {
    lastTime = now;
    lastRandom = randomBytes(RANDOM_LEN);
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}
