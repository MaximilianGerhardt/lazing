/**
 * Pattern 2 Digital-Twin — Workspace-aware Redaction (Privacy-Sprint 2026-05-01).
 *
 * Critic-VETO V1: the owner twin may contain private/personal data
 * (legal cases, finances, private disputes, etc.). Bei einem
 * Sub-Spawn in einem Kunden-Workspace (z.B. demo-fitness, sensitivity
 * 'low') wird der komplette Twin als Klartext an die LLM-Cloud (Anthropic)
 * geschickt. Das ist DSGVO-kritisch.
 *
 * Lösung: Vor jedem Spawn wird der Twin gegen die Workspace-Sensitivity
 * redigiert:
 *   - Workspace 'high' (User-/Privat-/Legal-Workspace): voller Twin OK
 *   - Workspace 'low' oder kein Domain-Twin: Redaction
 *     - sensitive_themen: nur "harmlose" Labels (kunden-credentials, api-keys)
 *     - projekte_aktiv: alle mit `sensitivity: 'high'` werden entfernt
 *
 * Token-Budget: Redaction macht den Twin kleiner — das <500-Tokens-Soft-Cap
 * bleibt automatisch eingehalten.
 */

import type { OwnerTwin } from "./types";
import type { DomainTwin } from "./types";

/**
 * Welche sensitive_themen dürfen in einen low-sensitivity-Workspace?
 * Faustregel: alles was a) keinen Personen-/Geld-Bezug hat und b) für
 * jeden Sub-Agent als Operational-Hint nützlich ist.
 *
 * Als allowlist gepflegt — der Default für unbekannte Labels ist "redact".
 */
const SAFE_SENSITIVE_LABELS = new Set<string>([
  "kunden-credentials",
  "api-keys",
]);

/**
 * Liefert eine kopierte und ggf. redigierte Variante des owner twins.
 *
 * - `domainTwin` null oder sensitivity='low' → Redaction aktiv
 * - `domainTwin.sensitivity === 'high'` → Twin unverändert
 *
 * Mutiert den Input nicht (deep-shallow-Copy für Arrays).
 */
export function redactOwnerTwinForWorkspace(
  ownerTwin: OwnerTwin,
  domainTwin: DomainTwin | null,
): OwnerTwin {
  const isHighSensitivity = domainTwin?.sensitivity === "high";
  if (isHighSensitivity) {
    // User-eigener Workspace = Trust-Zone, voller Twin OK.
    return ownerTwin;
  }

  // Low-sensitivity ODER kein Domain-Twin → Redaction.
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
