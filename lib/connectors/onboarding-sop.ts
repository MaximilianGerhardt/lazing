/**
 * Generic Auto-Onboarding-SOP Engine — Stream X1 · 2026-05-28.
 *
 * Public API:
 *   getOnboardingSop(providerId)                  → OnboardingSop | null
 *   buildOnboardingSopForMissingTool(missingTool) → OnboardingSop | null
 *   listOnboardingSops()                          → readonly OnboardingSop[]
 *
 * Owner-Direktive #1 (verbatim, N1):
 *   'Onboarding-SOP's sollten ja grundsätzlich sein oder der Flow... nur denk
 *    daran, dass das wieder aus Intention und Context selber aufgerufen werden
 *    muss."
 *
 * Therefore Onboarding is a GENERIC pattern (not a Higgsfield-special) that is
 * automatically triggered whenever the flow-coupling surface is emitted from the
 * existing compose-and-run path (lib/flow/compose-and-run.ts → SSE
 * `<surface:flow-coupling>`) — adding a SOP definition for a new provider is
 * just appending one entry to ONBOARDING_SOPS below.
 *
 * Design principles:
 *   N1 (Detail preservation): every step text / instruction is stored VERBATIM.
 *                             No truncation, no `.slice`/`.substring`.
 *   N6 (Deterministic first): this module is pure — no LLM, no I/O, no network.
 *   N4 (Recovery before reinvent): consumes the existing MissingTool reason set
 *                                  from lib/flow/compose.ts. Mirrors the existing
 *                                  P5_TOOL_CONNECTORS registry shape
 *                                  (lib/connectors/p5-tool-connectors.ts) so a
 *                                  single new entry covers BOTH catalog + SOP.
 *   Security: no credential value is ever stored here — only the schema of
 *             what the owner would enter, plus a link to the existing
 *             CredentialRequestCard pathway (lib/chat/SurfaceRenderer.tsx).
 *
 * Provider sources (verified public signup URLs):
 *   - higgsfield     — https://higgsfield.ai (homepage; signup behind sign-in)
 *   - heygen-avatar  — https://app.heygen.com/login + Settings → API
 *   - imagegen2      — engine-backed via Codex/MAX session, NO separate signup.
 *
 * Dependencies: NONE (pure, type-only imports).
 */

import type { MissingTool } from "@/lib/flow/compose";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Single step in an onboarding SOP. Verbatim text per N1. */
export interface OnboardingSopStep {
  /** 1-based step number for UI ordering. */
  readonly num: number;
  /** Short step title (verbatim, N1). */
  readonly title: string;
  /** Full step instruction text (verbatim, N1 — no truncation). */
  readonly body: string;
  /**
   * Optional external link the owner can tap to perform the step
   * (account-signup-url, console-url, docs-url). null → step is purely
   * informational or in-chat (e.g. credential-enter step).
   */
  readonly href?: string | null;
  /**
   * Structural marker used by the renderer:
   *   'signup'      — link to provider sign-up / login.
   *   'key'         — owner gets / copies a key in the provider console.
   *   'budget'      — owner sets a provider-side budget (Owner-Direktive #2:
   *                   Provider-Budget statt eigenes Hard-Cap).
   *   'credential'  — open the existing CredentialRequestCard inline.
   *   'info'        — purely informational (e.g. engine-backed: nothing to do).
   */
  readonly kind: "signup" | "key" | "budget" | "credential" | "info";
}

/** A complete per-provider onboarding SOP. */
export interface OnboardingSop {
  /** Provider slug, must match lib/connectors/p5-tool-connectors.ts and
   *  lib/connectors/catalog.ts. */
  readonly providerId: string;
  /** Human-readable name (verbatim, N1). */
  readonly displayName: string;
  /**
   * Public sign-up URL — where the owner creates an account.
   * null for engine-backed providers (no separate account).
   */
  readonly accountSignupUrl: string | null;
  /**
   * Ordered list of human steps the owner walks through to obtain a key.
   * Verbatim text (N1). MUST contain at least the final 'credential' step
   * unless engineBacked === true.
   */
  readonly keyAcquisitionSteps: readonly OnboardingSopStep[];
  /**
   * URL to the provider's budget / spend-limits / quota console.
   * null when no such page exists. Owner-Direktive #2: BUDGET = provider-side,
   * NOT a hard cap inside lazing. We only HINT.
   */
  readonly providerBudgetHintUrl: string | null;
  /**
   * Verbatim instructions on WHERE/HOW to set a provider-side spend cap.
   * Shown as the body of the 'budget' step.
   */
  readonly providerBudgetInstructions: string;
  /**
   * One-line hint shown next to the credential input — what kind of value the
   * owner pastes (api key, oauth token, etc.). Verbatim (N1).
   */
  readonly credentialFieldHint: string;
  /**
   * true → provider has NO separate credential (e.g. imagegen2 → Codex/MAX).
   * The renderer hides the 'credential' step and shows an info step instead.
   */
  readonly engineBacked: boolean;
}

// ---------------------------------------------------------------------------
// Registry — the per-provider onboarding SOPs.
//
// Adding a new provider = appending one entry here. Lookup is exact-match on
// providerId — case-sensitive, matches the slug in connector_catalog.
// ---------------------------------------------------------------------------

const ONBOARDING_SOPS: readonly OnboardingSop[] = [
  // ── higgsfield — Motion / Video Graphics ────────────────────────────────────
  {
    providerId: "higgsfield",
    displayName: "Higgsfield (Motion / Video Graphics)",
    accountSignupUrl: "https://higgsfield.ai",
    keyAcquisitionSteps: [
      {
        num: 1,
        title: "Higgsfield-Konto anlegen oder einloggen",
        body:
          "Öffne higgsfield.ai im Browser und lege ein Konto an (oder logge dich ein, falls du schon eines hast). Higgsfield rendert Motion-/Video-Graphics-Clips aus Prompts oder Standbildern — das brauchen wir für den Motion-Schritt deines Flows.",
        href: "https://higgsfield.ai",
        kind: "signup",
      },
      {
        num: 2,
        title: "API-Key im Account-Bereich erzeugen",
        body:
          "Navigiere im eingeloggten Konto in den Account-/Developer-Bereich und erzeuge dort einen API-Key (manche Pläne zeigen den Key unter 'Settings → API' oder 'Workspace → Developers'). Kopiere den Key — du brauchst ihn gleich für die Eingabe in lazing. Falls Higgsfield in deinem Plan nur OAuth anbietet, ist das auch okay — der Flow erkennt das automatisch und stellt im Schritt 4 die passende Eingabe.",
        href: "https://higgsfield.ai",
        kind: "key",
      },
      {
        num: 3,
        title: "Provider-Budget bei Higgsfield setzen (Hinweis, kein Cap)",
        body:
          "Höchst empfohlen: lege bei Higgsfield direkt eine monatliche Ausgabe-Grenze oder ein Pre-paid-Guthaben fest. Das ist deine echte Absicherung — lazing zeigt zwar eine Kosten-Schätzung pro Schritt, setzt aber bewusst KEINEN Hard-Cap. Du allein entscheidest in der Provider-Konsole, wie viel maximal abgebucht werden darf.",
        href: "https://higgsfield.ai",
        kind: "budget",
      },
      {
        num: 4,
        title: "API-Key in den Vault einkleben",
        body:
          "Füge den eben kopierten Key unten ein — er landet verschlüsselt im laz.ing-Credential-Vault (api_credentials, scope=workspace) und NICHT im Chat-Verlauf, NICHT im SSE-Stream, NICHT im Ledger. Danach läuft der Flow direkt durch.",
        href: null,
        kind: "credential",
      },
    ],
    providerBudgetHintUrl: "https://higgsfield.ai",
    providerBudgetInstructions:
      "In der Higgsfield-Konsole im Billing-/Subscription-Bereich Pre-paid-Guthaben aufladen oder eine harte Monats-Grenze setzen. Das ist deine ECHTE Kostenbremse — lazing rechnet Schätzungen aus, blockiert aber nicht.",
    credentialFieldHint:
      "Higgsfield API Key (beginnt typischerweise mit hf_ oder hgs_ — exakt so einfügen, wie du ihn aus der Higgsfield-Konsole kopiert hast).",
    engineBacked: false,
  },

  // ── heygen-avatar — Talking Avatar / Explainer Video ────────────────────────
  {
    providerId: "heygen-avatar",
    displayName: "HeyGen (Talking Avatar / Explainer Video)",
    accountSignupUrl: "https://app.heygen.com/login",
    keyAcquisitionSteps: [
      {
        num: 1,
        title: "HeyGen-Konto anlegen oder einloggen",
        body:
          "Öffne app.heygen.com/login im Browser. Lege ein Konto an oder logge dich ein. HeyGen rendert dein Skript mit einem ausgewählten Avatar und einer Stimme zu einem fertigen Sprecher-Video — das brauchen wir für den Avatar-/Erklärfilm-Schritt deines Flows.",
        href: "https://app.heygen.com/login",
        kind: "signup",
      },
      {
        num: 2,
        title: "API-Key in den Account-Settings erzeugen",
        body:
          "Im eingeloggten Konto: oben rechts auf dein Profil → 'Settings' → linkes Menü 'API'. Klick auf 'Create new token' / 'Generate API Key' und kopiere den Wert. Das ist dein persönlicher HeyGen-Schlüssel — bewahre ihn sicher auf; HeyGen zeigt manchen Token nur EIN Mal an.",
        href: "https://app.heygen.com/settings/api",
        kind: "key",
      },
      {
        num: 3,
        title: "HeyGen-Plan-Limits prüfen (Hinweis, kein Cap)",
        body:
          "Sehr empfohlen: prüfe in der HeyGen-Konsole unter 'Subscription' / 'Billing', welcher Plan aktiv ist und wieviele Credits / Minuten dir pro Monat zur Verfügung stehen. Setze ggf. eine niedrigere Plan-Stufe oder ein Spending-Alert — das ist deine ECHTE Absicherung. laz.ing zeigt nur eine Schätzung pro Schritt, blockiert aber nicht.",
        href: "https://app.heygen.com/settings/subscription",
        kind: "budget",
      },
      {
        num: 4,
        title: "API-Key in den Vault einkleben",
        body:
          "Füge den eben kopierten HeyGen-API-Key unten ein — er landet verschlüsselt im laz.ing-Credential-Vault (api_credentials, scope=workspace) und NICHT im Chat-Verlauf, NICHT im SSE-Stream, NICHT im Ledger. Danach läuft der Flow direkt durch.",
        href: null,
        kind: "credential",
      },
    ],
    providerBudgetHintUrl: "https://app.heygen.com/settings/subscription",
    providerBudgetInstructions:
      "In der HeyGen-Konsole unter Subscription / Billing den Plan einstellen oder ein niedrigeres Credit-Paket wählen. Optional: E-Mail-Alert bei x % Verbrauch aktivieren. Das ist deine ECHTE Kostenbremse.",
    credentialFieldHint:
      "HeyGen API Key (in HeyGen unter Settings → API erzeugt; einmal sichtbar — kopier ihn sofort).",
    engineBacked: false,
  },

  // ── imagegen2 — engine-backed Image Generation (Codex/MAX) ──────────────────
  {
    providerId: "imagegen2",
    displayName: "ImageGen2 (Codex-backed Image Generation)",
    accountSignupUrl: null,
    keyAcquisitionSteps: [
      {
        num: 1,
        title: "Kein Setup nötig — läuft engine-backed",
        body:
          "imagegen2 nutzt die bestehende Codex/MAX-Session-Authentifizierung von laz.ing (lib/llm/engines/codex.ts). Du brauchst KEINEN separaten Account und KEINEN API-Key — die Bild-Generierung läuft direkt über deinen aktiven Codex/MAX-Login. Live-Calls bleiben trotzdem hinter dem globalen Master-Schalter LAZYOS_CONNECTOR_LIVE gegated (Default OFF = Dry-Run).",
        href: null,
        kind: "info",
      },
      {
        num: 2,
        title: "Codex/MAX-Verbrauch beobachten (Hinweis, kein Cap)",
        body:
          "Bild-Generierung kostet Codex/MAX-Kontingent. Du behältst die Hoheit über dein Codex/MAX-Konto: dort ggf. Plan-Stufe oder Spending-Alert prüfen. laz.ing macht KEINEN Hard-Cap — wir zeigen nur eine Schätzung pro Schritt.",
        href: null,
        kind: "budget",
      },
    ],
    providerBudgetHintUrl: null,
    providerBudgetInstructions:
      "Verbrauchs-Limits werden direkt im Codex/MAX-Account verwaltet (laz.ing nutzt die bestehende Session). Kein zusätzlicher Cap nötig — Schätzungen sind reine Hinweise.",
    credentialFieldHint: "Kein Key nötig — engine-backed.",
    engineBacked: true,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up an onboarding SOP by provider slug. Exact, case-sensitive match.
 * Returns null when no SOP is registered — caller MUST handle null gracefully
 * (Owner-Direktive #1: this is a generic pattern, but unknown providers should
 * fall back to the existing CredentialRequestCard without an extra SOP wrapper,
 * not crash).
 */
export function getOnboardingSop(providerId: string | null | undefined): OnboardingSop | null {
  if (!providerId) return null;
  return ONBOARDING_SOPS.find((s) => s.providerId === providerId) ?? null;
}

/**
 * Build an OnboardingSop instance for a MissingTool reported by compose.ts.
 *
 * Strategy:
 *   1. If missingTool.provider === null → no SOP (we don't know which
 *      provider; the renderer falls back to the existing
 *      "Tool für diesen Schritt wählen" hint).
 *   2. Look up by provider slug.
 *   3. Return null for unknown providers — caller stays backwards-compatible
 *      and renders the original CredentialRequestCard pathway.
 *
 * Pure, no side effects, no I/O.
 */
export function buildOnboardingSopForMissingTool(
  missingTool: Pick<MissingTool, "provider" | "reason">,
): OnboardingSop | null {
  if (!missingTool.provider) return null;
  return getOnboardingSop(missingTool.provider);
}

/**
 * Iterate over all registered onboarding SOPs. Read-only view of the registry.
 */
export function listOnboardingSops(): readonly OnboardingSop[] {
  return ONBOARDING_SOPS;
}
