/**
 * Pattern 2 Digital-Twin — workspace-aware redaction (Privacy Sprint 2026-05-01).
 *
 * Critic-VETO V1: the owner twin may contain private/personal data
 * (legal cases, finances, private disputes, etc.). On a
 * sub-spawn in a client workspace (e.g. demo-fitness, sensitivity
 * 'low'), the entire twin is sent as plain text to the LLM cloud (Anthropic).
 * That is GDPR-critical.
 *
 * Solution: before each spawn, the twin is redacted against the workspace
 * sensitivity:
 *   - Workspace 'high' (user/private/legal workspace): full twin OK
 *   - Workspace 'low' or no domain twin: redaction
 *     - sensitive_themen: only "harmless" labels (kunden-credentials, api-keys)
 *     - projekte_aktiv: all with `sensitivity: 'high'` are removed
 *
 * Token budget: redaction makes the twin smaller — the <500-tokens soft cap
 * stays satisfied automatically.
 */

import type { OwnerTwin } from "./types";
import type { DomainTwin } from "./types";

/**
 * Which sensitive_themen are allowed into a low-sensitivity workspace?
 * Rule of thumb: anything that a) has no person/money relevance and b) is
 * useful to every sub-agent as an operational hint.
 *
 * Maintained as an allowlist — the default for unknown labels is "redact".
 */
const SAFE_SENSITIVE_LABELS = new Set<string>([
  "kunden-credentials",
  "api-keys",
]);

/**
 * Returns a copied and possibly redacted variant of the owner twin.
 *
 * - `domainTwin` null or sensitivity='low' → redaction active
 * - `domainTwin.sensitivity === 'high'` → twin unchanged
 *
 * Does not mutate the input (deep-shallow copy for arrays).
 */
export function redactOwnerTwinForWorkspace(
  ownerTwin: OwnerTwin,
  domainTwin: DomainTwin | null,
): OwnerTwin {
  const isHighSensitivity = domainTwin?.sensitivity === "high";
  if (isHighSensitivity) {
    // User's own workspace = trust zone, full twin OK.
    return ownerTwin;
  }

  // Low-sensitivity OR no domain twin → redaction.
  return {
    ...ownerTwin,
    projekte_aktiv: ownerTwin.projekte_aktiv.filter(
      (p) => p.sensitivity !== "high",
    ),
    sensitive_themen: ownerTwin.sensitive_themen.filter((label) =>
      SAFE_SENSITIVE_LABELS.has(label),
    ),
  };
}
