/**
 * VAPID Key Encoding Helper.
 *
 * The web-push spec expects the public key as a Uint8Array (raw ECDSA point).
 * We serve it as a URL-safe base64 string from the env and convert it on the
 * client.
 */

/**
 * Returns the raw 65-byte public key as a Uint8Array over a fresh
 * `ArrayBuffer` (not `SharedArrayBuffer`). Necessary because
 * PushManager.subscribe.applicationServerKey expects a `BufferSource` with
 * a concrete `ArrayBuffer` (TS lib.dom is strict).
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
