/**
 * Crypto primitives for auth + sensitivity enforcement.
 *
 * Runs in Node-runtime AND Edge-runtime. We use the Web-Crypto
 * `crypto.subtle` API because `node:crypto` is not available in
 * Edge/Middleware. SubtleCrypto is available in both runtimes
 * (Edge via Fetch API, Node 18+ via globalThis.crypto).
 */

const encoder = new TextEncoder();

/**
 * Constant-time string comparison. Works on any runtime — no
 * `node:crypto.timingSafeEqual` dependency.
 *
 * Fails fast on length-mismatch by XOR-ing against a fixed-length
 * scratch buffer so attackers cannot learn the expected length.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  // Compare against whichever is longer so timing is dominated by the
  // larger input; length-mismatch still returns false but after a full
  // pass over the longer buffer.
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i += 1) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const b = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) return new Uint8Array(0);
    bytes[i] = b;
  }
  return bytes;
}

export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(sig);
}

export async function hmacSha256Verify(
  secret: string,
  message: string,
  expectedHex: string,
): Promise<boolean> {
  // Works around all ArrayBuffer-instanceof problems in the Edge runtime:
  // we re-sign the message and compare the hex strings directly
  // (constant-time). crypto.subtle.verify() has chronic problems with
  // TypedArray/ArrayBuffer polyfills in the Next-Edge build.
  if (expectedHex.length === 0) return false;
  const actualHex = await hmacSha256Hex(secret, message);
  if (actualHex.length !== expectedHex.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < actualHex.length; i += 1) {
    diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Short base64url random ID. Used for session tokens + CSRF tokens.
 * 32 bytes of entropy → 43 chars base64url.
 */
export function randomTokenBase64Url(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let binary = "";
  for (let i = 0; i < buf.length; i += 1) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
