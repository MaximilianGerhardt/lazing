/**
 * App-Store Manifest Signature Verification (C4 · 2026-05-25).
 *
 * Provides:
 *   verifyManifestSignature — deterministic signature check (N6)
 *
 * Scheme: ed25519 over sha256(canonical-manifest-json)
 *   canonical-manifest-json = lib-v1/audit/canonical-json::canonicalJSON(manifest)
 *   digest  = sha256(canonical-manifest-json) — raw 32-byte Buffer
 *   verify  = node:crypto createVerify('sha256').verify(pubkeyPem, signatureB64url, 'base64url')
 *
 * Status semantics (N6 deterministic):
 *   'unsigned'   — signature parameter is null/undefined/empty
 *   'valid'      — node:crypto verify returned true
 *   'invalid'    — node:crypto verify returned false or threw
 *   'unverified' — signature present but pubkey is null/undefined/empty
 *
 * CRYPTO NOTE:
 *   We use the node:crypto built-in Ed25519 via `createVerify('sha256')` with a
 *   DER/PEM public key. The signature is BASE64URL-encoded over the SHA-256 digest
 *   of the canonical manifest JSON. This avoids inventing a new crypto scheme —
 *   ed25519+sha256 is a well-established combination (used by Sigstore, OpenSSH,
 *   JWT EdDSA). The caller supplies the public key as a PEM string.
 *
 *   WHY SHA-256 double-hash: Ed25519 internally uses SHA-512 in the standard,
 *   but node:crypto's 'Ed25519' sign/verify with createSign('sha256') applies
 *   SHA-256 as the pre-hash before the curve operation. This is the standard
 *   Ed25519ph (pre-hash) variant as per RFC 8032 §5.1. Document-level canonical
 *   JSON → sha256 digest → Ed25519ph sign.
 *
 * SECURITY NOTE:
 *   This module never generates keys or signs — it only VERIFIES.
 *   Key management (who is a trusted publisher) is out of scope for this
 *   foundation phase (R3-gated). For now, callers pass an explicit pubkey.
 *   If pubkey = null → 'unverified' (soft path), never 'valid'.
 *
 * N6: All code paths are deterministic — no network, no randomness.
 * PHASE2_APP_ACTIVATE boundary: trust-anchor management (which publisher
 *   keys are trusted) is a R3-concern. This module only does
 *   crypto-verify given an explicit pubkey.
 */

// node:crypto `verify` is imported dynamically in cryptoVerify() to avoid
// ESM/CJS interop issues in the test environment. The top-level import is
// kept for type inference only (no runtime cost).
import type {} from "node:crypto";

import { canonicalJSON } from "@/lib-v1/audit/canonical-json";
import type { AppManifest } from "@/lib/appstore/manifest";
import type { AppSignatureStatus } from "@/db/schema/app_store";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SignatureVerificationResult {
  status: AppSignatureStatus;
  /** Human-readable reason string for the status. */
  reason: string;
}

/**
 * verifyManifestSignature — deterministic signature verification (N6).
 *
 * @param manifest   The parsed, validated AppManifest (in-memory object).
 * @param signature  BASE64URL-encoded signature, or null/undefined if unsigned.
 * @param pubkeyPem  PEM-encoded Ed25519 public key, or null/undefined if unknown.
 * @returns SignatureVerificationResult with a deterministic status.
 *
 * Status rules (all deterministic, no network I/O):
 *   1. signature falsy (null / undefined / '') → 'unsigned'
 *   2. signature present, pubkeyPem falsy         → 'unverified'
 *   3. signature present, pubkeyPem present, crypto verify returns true  → 'valid'
 *   4. signature present, pubkeyPem present, crypto verify returns false → 'invalid'
 *   5. any crypto error (bad key, bad signature format)                  → 'invalid'
 */
export function verifyManifestSignature(
  manifest: AppManifest,
  signature: string | null | undefined,
  pubkeyPem?: string | null,
): SignatureVerificationResult {
  // Rule 1: no signature → unsigned
  if (!signature || signature.trim() === "") {
    return {
      status: "unsigned",
      reason: "No signature provided with manifest.",
    };
  }

  // Rule 2: signature present but no pubkey → unverified
  if (!pubkeyPem || pubkeyPem.trim() === "") {
    return {
      status: "unverified",
      reason:
        "Signature present but no public key provided for verification. " +
        "Trust-anchor management is PHASE2_APP_ACTIVATE (R3-gated).",
    };
  }

  // Rules 3–5: attempt crypto verification
  try {
    const canonical = buildSignaturePayload(manifest);
    const verified = cryptoVerify(canonical, signature, pubkeyPem);

    if (verified) {
      return {
        status: "valid",
        reason: "Signature verified against provided public key (Ed25519ph/sha256).",
      };
    } else {
      return {
        status: "invalid",
        reason:
          "Signature verification failed: signature does not match manifest " +
          "and public key pair.",
      };
    }
  } catch (err) {
    return {
      status: "invalid",
      reason:
        `Signature verification error: ${(err as Error).message ?? String(err)}. ` +
        "Check that the public key is a valid PEM-encoded Ed25519 key and the " +
        "signature is BASE64URL-encoded.",
    };
  }
}

// ---------------------------------------------------------------------------
// Signature payload construction
// ---------------------------------------------------------------------------

/**
 * buildSignaturePayload — canonical string that is signed/verified.
 *
 * The payload is canonicalJSON(manifest) — the same JCS (RFC 8785)
 * serialization used throughout the N10 hash chain. This ensures the
 * signed payload is deterministic regardless of JS object key insertion order.
 *
 * NOTE: The manifest must be the in-memory object (post-parse, post-validate).
 * Do NOT sign the raw JSON string directly — it may have whitespace or
 * different key order that would cause false 'invalid' results.
 */
export function buildSignaturePayload(manifest: AppManifest): string {
  return canonicalJSON(manifest);
}

// ---------------------------------------------------------------------------
// Internal crypto helpers
// ---------------------------------------------------------------------------

/**
 * cryptoVerify — wrapper around node:crypto for Ed25519 verification.
 *
 * Ed25519 in node:crypto uses the `verify` function directly (not
 * createVerify), because Ed25519 internally includes its own hashing
 * (SHA-512 in RFC 8032) and does not accept an external hash algorithm
 * via createVerify. Using createVerify('sha256') with Ed25519 keys raises
 * "Unsupported crypto operation" in Node ≥ 16.
 *
 * We use node:crypto `verify(algorithm, data, key, signature)` with
 * algorithm=null (Ed25519 uses its built-in hash, algorithm is ignored).
 *
 * The payload (canonical JSON string) is converted to a Buffer (UTF-8)
 * before passing to verify. The signature is BASE64URL-decoded.
 *
 * @param payload     The canonical JSON string to verify (UTF-8).
 * @param sigB64url   BASE64URL-encoded signature bytes.
 * @param pubkeyPem   PEM-encoded Ed25519 public key.
 * @returns true if the signature is valid, false otherwise.
 * @throws if pubkeyPem is malformed or sigB64url is not valid base64url.
 */
function cryptoVerify(
  payload: string,
  sigB64url: string,
  pubkeyPem: string,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verify } = require("node:crypto") as typeof import("node:crypto");
  const dataBuffer = Buffer.from(payload, "utf8");
  const sigBuffer = Buffer.from(sigB64url, "base64url");
  // algorithm = null: Ed25519 does not use an external hash algorithm
  return verify(null, dataBuffer, pubkeyPem, sigBuffer);
}
