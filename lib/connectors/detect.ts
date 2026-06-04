/**
 * Connector detection — ACL5-A · 2026-05-24.
 *
 * Detects from a chat request which external API/connection is needed.
 *
 * Design principles:
 *
 *   N6 (Deterministic validators precede symbolic reasoning):
 *     `detectConnector()` is PURE and deterministic. No LLM, no I/O,
 *     no async. Same input → always the same output.
 *     The optional LLM fallback is factored out as a SEPARATE function
 *     `classifyWithLlmFallback` — the caller invokes it deliberately, not the hot-path default.
 *
 *   N8 (Trace is evidence):
 *     The `rationale` field describes the decision path verbatim —
 *     N8-suitable as a "why did we decide this?" line in an audit row.
 *
 *   Security posture:
 *     - No credentials are read, decrypted or logged.
 *     - `hasCredential(provider, workspaceId)` is a pure existence check
 *       (COUNT query without decrypt). It is documented as a separate helper
 *       and left to the caller (see below: "Credential check note").
 *     - This module imports the DB ONLY for `listConnectors()` / `getConnectorProfile()`
 *       (platform-global catalog, no sensitive data, D1).
 *
 * Dependencies:
 *   lib/connectors/catalog.ts — listConnectors, getConnectorProfile, listCapabilities.
 *   No further imports (no vault, no LLM, no I/O in the default path).
 */

import {
  listConnectors,
  getConnectorProfile,
  listCapabilities,
} from "@/lib/connectors/catalog";
import type { ConnectorCatalogRow, ConnectorCapabilityRow } from "@/db/schema/connectors";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of `detectConnector`.
 *
 * - `provider`           : matched catalog provider slug (e.g. 'heygen'), or null.
 * - `neededCapabilities` : capability names roughly derived from the request.
 * - `confidence`         : 0..1 — computed deterministically from the match type:
 *                            1.0 = exact provider-name/alias match in the catalog
 *                            0.7 = keyword heuristic hits a catalog provider
 *                            0.3 = keyword heuristic without a catalog match ('no-connector')
 *                            0.0 = no signal
 * - `missing`            : status of the provider/credentials:
 *                            'none'          — profile + credential present (per caller context).
 *                            'credential'    — profile known, credential unknown (vault check missing).
 *                            'profile'       — provider recognized (name/alias meant), but no catalog entry.
 *                            'no-connector'  — no connector reference recognized.
 * - `rationale`          : N8-suitable justification (verbatim, no paraphrasing).
 */
export interface ConnectorDetection {
  provider: string | null;
  neededCapabilities: string[];
  confidence: number;
  missing: "profile" | "credential" | "none" | "no-connector";
  rationale: string;
}

/**
 * Caller context for `detectConnector`.
 *
 * - `workspaceId`  : required — for future credential checks (ACL5-B/C).
 * - `hasCredential`: optional injected check (recommended for the ACL5-C integration).
 *                   If not passed, `missing` is set conservatively to 'credential'
 *                   (no credential knowledge → fail-closed ≠ 'none').
 *
 * Credential check note:
 *   The caller can inject a lightweight "hasCredential(provider, workspaceId)" check.
 *   It MUST NOT decrypt — only check existence:
 *
 *     const result = detectConnector(prompt, {
 *       workspaceId,
 *       hasCredential: (provider) => {
 *         const db = getDb();
 *         const row = db.$raw
 *           .prepare(
 *             `SELECT COUNT(*) as n FROM api_credentials
 *              WHERE scope_kind = 'workspace' AND scope_id = ? AND provider = ?`
 *           )
 *           .get(workspaceId, provider) as { n: number } | undefined;
 *         return (row?.n ?? 0) > 0;
 *       },
 *     });
 *
 *   The intentional design: `detect.ts` itself makes no DB call on api_credentials
 *   (vault). This keeps the module free of any dependency on the credential path and
 *   usable in tests without a vault mock.
 */
export interface DetectContext {
  workspaceId: string;
  hasCredential?: (provider: string) => boolean;
}

// ---------------------------------------------------------------------------
// Keyword → capability heuristic table
//
// Maps generic domain terms (DE + EN) onto coarse capability names.
// This heuristic is DETERMINISTIC — no weighting, no LLM.
// The capability names here are canonical examples; `detectConnector` does NOT
// reconcile them against the catalog (that is the caller's job via validateCoverage).
//
// Order: more specific patterns first.
// ---------------------------------------------------------------------------

interface KeywordRule {
  /** Regex pattern (case-insensitive, the global flag is set internally). */
  pattern: RegExp;
  /** Capability names this keyword implies. */
  capabilities: string[];
  /** Optional: provider hint — if set, it is checked as a provider candidate. */
  providerHint?: string;
}

const KEYWORD_RULES: KeywordRule[] = [
  // Video rendering / avatars
  {
    pattern: /\b(video|render|avatar|heygen|talking.head|sprechender?\s+kopf)\b/i,
    capabilities: ["render_video", "list_avatars"],
    providerHint: "heygen",
  },
  // Image generation
  {
    pattern:
      /\b(image.gen|bild.generi|dall-?e|midjourney|stable.diffusion|generate.image|bild.erstell)\b/i,
    capabilities: ["generate_image"],
  },
  // Email sending
  {
    pattern: /\b(send.mail|e.?mail.senden|email.send|smtp|sendgrid|mailgun|resend)\b/i,
    capabilities: ["send_email"],
  },
  // SMS / WhatsApp
  {
    pattern: /\b(sms|whatsapp|twilio|text.message|nachricht.senden)\b/i,
    capabilities: ["send_sms"],
  },
  // Social Media — Instagram
  {
    pattern: /\b(instagram|ig.post|post.auf.instagram|instagram.api)\b/i,
    capabilities: ["post_media", "list_posts"],
    providerHint: "instagram",
  },
  // Social Media — Twitter / X
  {
    pattern: /\b(tweet|twitter|x\.com|post.auf.x)\b/i,
    capabilities: ["post_tweet"],
    providerHint: "twitter",
  },
  // Social media — general
  {
    pattern:
      /\b(social.media|poste.auf|post.to|veröffentliche.auf|schedule.post|content.planen)\b/i,
    capabilities: ["post_media"],
  },
  // Payment
  {
    pattern: /\b(payment|zahlung|stripe|invoice|rechnung|checkout|subscription)\b/i,
    capabilities: ["create_payment", "list_invoices"],
    providerHint: "stripe",
  },
  // Calendar / Kalender
  {
    pattern:
      /\b(calendar|kalender|appointment|termin|event.erstell|event.create|google.calendar)\b/i,
    capabilities: ["create_event", "list_events"],
    providerHint: "google-calendar",
  },
  // Storage / files
  {
    pattern: /\b(upload|datei.hochlad|file.upload|s3|storage|bucket)\b/i,
    capabilities: ["upload_file", "list_files"],
  },
  // CRM / contacts
  {
    pattern: /\b(crm|kontakt|contact|hubspot|salesforce|lead|deal)\b/i,
    capabilities: ["create_contact", "list_contacts"],
  },
  // GitHub / Git
  {
    pattern: /\b(github|pull.request|issue|repository|commit|pr.erstell)\b/i,
    capabilities: ["create_issue", "list_repos"],
    providerHint: "github",
  },
  // OpenAI / LLM
  {
    pattern: /\b(openai|gpt|completion|chat.completion|llm.api)\b/i,
    capabilities: ["chat_completion"],
    providerHint: "openai",
  },
  // Slack
  {
    pattern: /\b(slack|slack.message|kanal.nachricht|channel.message)\b/i,
    capabilities: ["send_message"],
    providerHint: "slack",
  },
  // Google Sheets / spreadsheets
  {
    pattern: /\b(google.sheet|spreadsheet|tabelle|google.docs|sheets.api)\b/i,
    capabilities: ["read_sheet", "write_sheet"],
    providerHint: "google-sheets",
  },
  // Notion
  {
    pattern: /\b(notion|notion.page|notion.database)\b/i,
    capabilities: ["create_page", "list_pages"],
    providerHint: "notion",
  },
  // Zapier / Webhook / Integration
  {
    pattern: /\b(webhook|zapier|make\.com|integromat|trigger)\b/i,
    capabilities: ["trigger_webhook"],
  },
];

// ---------------------------------------------------------------------------
// Main function: detectConnector (N6 deterministic — no LLM, no async)
// ---------------------------------------------------------------------------

/**
 * Deterministically detects which external connector/provider is needed for a
 * chat prompt.
 *
 * Flow:
 *   1. Normalization: lowercase-trim of the prompt.
 *   2. Provider-name/alias match: checks whether a catalog provider slug or
 *      `displayName` appears directly in the prompt (exact match, word boundary).
 *      On a hit: confidence = 1.0.
 *   3. Keyword heuristic: checks all KEYWORD_RULES against the prompt.
 *      On a hit: `providerHint` against the catalog; confidence = 0.7 (catalog hit)
 *      or 0.3 (no catalog hit).
 *   4. No signal: provider = null, missing = 'no-connector', confidence = 0.
 *
 * N6: deterministic — same input → same output (no stochasticity).
 * N8: `rationale` documents the decision path verbatim.
 * No LLM, no I/O on api_credentials (no vault access).
 *
 * @param prompt  - The raw chat prompt (any length, DE or EN).
 * @param ctx     - Caller context: workspaceId + optional hasCredential check.
 * @returns       ConnectorDetection (always a value, never null/undefined).
 */
export function detectConnector(
  prompt: string,
  ctx: DetectContext,
): ConnectorDetection {
  const normalized = prompt.toLowerCase().trim();

  // ── 1. Provider-name/alias match against listConnectors() ────────────────
  //
  // Loads all catalog entries (platform-global, no scope, no credential).
  // Checks whether the provider slug or displayName (lowercase) appears as a
  // word boundary in the normalized prompt.
  //
  // Benefit: the providerHint heuristic needs the catalog only once.
  // Performance: listConnectors() uses getDb() → synchronous, no network.

  const catalogRows = loadCatalogSafe();

  for (const row of catalogRows) {
    const slugPattern = buildWordBoundaryPattern(row.provider);
    const displayPattern = buildWordBoundaryPattern(row.displayName.toLowerCase());

    if (slugPattern.test(normalized) || displayPattern.test(normalized)) {
      // Exact catalog match
      const neededCapabilities = extractCapabilitiesFromCatalog(row.provider);
      const missing = resolveMissingStatus(row.provider, ctx, "catalogHit");

      return {
        provider: row.provider,
        neededCapabilities,
        confidence: 1.0,
        missing,
        rationale:
          `N6-deterministisch: Provider-Slug/DisplayName-Match auf Katalog-Eintrag ` +
          `"${row.provider}" (displayName: "${row.displayName}"). ` +
          `Capabilities aus Katalog: [${neededCapabilities.join(", ")}]. ` +
          `missing=${missing}.`,
      };
    }
  }

  // ── 2. Keyword heuristic ──────────────────────────────────────────────────
  //
  // Checks KEYWORD_RULES in order (most specific first).
  // First hit wins (conservative: no multi-match fan-out).

  for (const rule of KEYWORD_RULES) {
    const re = new RegExp(rule.pattern.source, "gi");
    const match = re.exec(normalized);

    if (match !== null) {
      const matchedText = match[0];
      const hintProvider = rule.providerHint ?? null;

      // Check whether the providerHint exists in the catalog
      const catalogRow = hintProvider ? getCatalogRowSafe(hintProvider) : null;

      if (catalogRow !== null) {
        // Keyword + catalog hit: confidence 0.7
        const neededCapabilities = mergeCapabilities(
          rule.capabilities,
          extractCapabilitiesFromCatalog(catalogRow.provider),
        );
        const missing = resolveMissingStatus(catalogRow.provider, ctx, "keywordCatalogHit");

        return {
          provider: catalogRow.provider,
          neededCapabilities,
          confidence: 0.7,
          missing,
          rationale:
            `N6-deterministisch: Keyword-Heuristik traf "${matchedText}" → ` +
            `providerHint="${hintProvider}" im Katalog gefunden. ` +
            `Capabilities (merged): [${neededCapabilities.join(", ")}]. ` +
            `missing=${missing}.`,
        };
      }

      if (hintProvider !== null) {
        // Provider hint recognized but NOT in the catalog: missing='profile'
        return {
          provider: hintProvider,
          neededCapabilities: rule.capabilities,
          confidence: 0.7,
          missing: "profile",
          rationale:
            `N6-deterministisch: Keyword-Heuristik traf "${matchedText}" → ` +
            `providerHint="${hintProvider}" erkannt, aber KEIN Eintrag in connector_catalog. ` +
            `missing='profile' (Katalog-Lücke, nicht Credential-Problem). ` +
            `Capabilities (heuristisch): [${rule.capabilities.join(", ")}].`,
        };
      }

      // Keyword without a provider hint: no concrete provider, but a capability signal
      return {
        provider: null,
        neededCapabilities: rule.capabilities,
        confidence: 0.3,
        missing: "no-connector",
        rationale:
          `N6-deterministisch: Keyword-Heuristik traf "${matchedText}" → ` +
          `Capabilities-Hinweis [${rule.capabilities.join(", ")}], ` +
          `aber kein Provider-Hint und kein Katalog-Match. ` +
          `missing='no-connector'.`,
      };
    }
  }

  // ── 3. No signal ──────────────────────────────────────────────────────────

  return {
    provider: null,
    neededCapabilities: [],
    confidence: 0,
    missing: "no-connector",
    rationale:
      "N6-deterministisch: Kein Provider-Name/Alias-Match und kein Keyword-Treffer. " +
      "Kein Connector-Bezug erkannt.",
  };
}

// ---------------------------------------------------------------------------
// Internal helper functions (pure, no side effects except DB reads)
// ---------------------------------------------------------------------------

/**
 * Loads all catalog rows safely. Returns an empty array if the DB
 * is unreachable (e.g. in unit tests without a DB mock).
 *
 * N6: fail-safe — no crash if the DB is unavailable.
 */
function loadCatalogSafe(): ConnectorCatalogRow[] {
  try {
    return listConnectors();
  } catch {
    return [];
  }
}

/**
 * Fetches a single catalog entry safely.
 * Returns null on error or a missing entry.
 */
function getCatalogRowSafe(provider: string): ConnectorCatalogRow | null {
  try {
    return getConnectorProfile(provider);
  } catch {
    return null;
  }
}

/**
 * Extracts capability names for a provider from the catalog.
 * Returns an empty array on error or a missing entry.
 */
function extractCapabilitiesFromCatalog(provider: string): string[] {
  try {
    const caps: ConnectorCapabilityRow[] = listCapabilities(provider);
    return caps.map((c) => c.name);
  } catch {
    return [];
  }
}

/**
 * Builds a word-boundary pattern for a term.
 * Escapes regex special characters in the term (e.g. for "google-calendar").
 *
 * Note: the word boundary \b does not work reliably with special characters
 * like hyphens. Therefore: (?<![a-z0-9]) + term + (?![a-z0-9]) as an
 * alternative boundary pattern for provider slugs with hyphens.
 */
function buildWordBoundaryPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // For provider slugs with hyphens: no real word boundaries are needed,
  // we only check whether the term appears as a (contextually isolated) substring.
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

/**
 * Merges two capability lists without duplicates (order: heuristic first,
 * then catalog caps not yet in the heuristic list).
 */
function mergeCapabilities(heuristic: string[], catalog: string[]): string[] {
  const seen = new Set(heuristic);
  const merged = [...heuristic];
  for (const cap of catalog) {
    if (!seen.has(cap)) {
      seen.add(cap);
      merged.push(cap);
    }
  }
  return merged;
}

/**
 * Determines the `missing` status deterministically.
 *
 * - If `ctx.hasCredential` is injected: checks existence via the callback.
 * - If `ctx.hasCredential` is NOT injected: conservatively 'credential'
 *   (we do not know whether a credential exists → fail-closed, not 'none').
 *
 * N6: deterministic, no I/O directly in this module.
 */
function resolveMissingStatus(
  provider: string,
  ctx: DetectContext,
  _matchType: "catalogHit" | "keywordCatalogHit",
): "none" | "credential" {
  if (ctx.hasCredential !== undefined) {
    return ctx.hasCredential(provider) ? "none" : "credential";
  }
  // No hasCredential callback: conservatively 'credential' (we do not know)
  return "credential";
}

// ---------------------------------------------------------------------------
// Optional LLM fallback — SEPARATE function, NOT in the hot-path default.
//
// This function is NOT called by `detectConnector()`.
// The caller must invoke it explicitly when the deterministic detection
// is insufficient (confidence < threshold or missing='no-connector').
//
// IMPORTANT: this function is a stub. The actual LLM integration
// (via the lazyOS orchestrator / Codex) lives outside this module.
// It is documented here solely as a clearly named entry point, so that
// future implementations find it and do not accidentally undo the
// hot-path vs. LLM-fallback separation.
// ---------------------------------------------------------------------------

/**
 * Optional LLM classification fallback.
 *
 * NOT in the hot path of detectConnector(). Only call it when:
 *   1. detectConnector() returns missing='no-connector' or confidence < 0.5.
 *   2. The caller can afford the LLM cost.
 *
 * Stub: returns the same `fallback` value the caller passes.
 * Replace the body with a real LLM call once ACL5-E implements the chat
 * wiring.
 *
 * @param _prompt   - The original prompt.
 * @param fallback  - Result from `detectConnector()` as a starting point.
 * @param _ctx      - Caller context (workspaceId, hasCredential).
 * @returns         ConnectorDetection — the LLM may refine `provider` and
 *                  `neededCapabilities`; `rationale` MUST carry
 *                  "LLM-Fallback: " as a prefix (N8-suitable).
 */
export function classifyWithLlmFallback(
  _prompt: string,
  fallback: ConnectorDetection,
  _ctx: DetectContext,
): ConnectorDetection {
  // STUB — plug the real LLM integration in here.
  // Until implemented: return the deterministic result unchanged.
  return {
    ...fallback,
    rationale: `LLM-Fallback (stub, nicht implementiert): ${fallback.rationale}`,
  };
}
