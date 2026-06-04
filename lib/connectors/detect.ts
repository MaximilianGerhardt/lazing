/**
 * Connector-Detection — ACL5-A · 2026-05-24.
 *
 * Erkennt aus einer Chat-Anfrage, welche externe API/Connection gebraucht wird.
 *
 * Design-Prinzipien:
 *
 *   N6 (Deterministic validators precede symbolic reasoning):
 *     `detectConnector()` ist PURE und deterministisch. Kein LLM, kein I/O,
 *     kein async. Gleicher Input → immer gleicher Output.
 *     Der optionale LLM-Fallback ist als SEPARATE Funktion `classifyWithLlmFallback`
 *     ausgelagert — der Caller ruft sie bewusst auf, nicht der Hot-Path-Default.
 *
 *   N8 (Trace is evidence):
 *     Das `rationale`-Feld beschreibt den Entscheidungspfad verbatim —
 *     N8-tauglich als "why did we decide this?"-Zeile in einem Audit-Row.
 *
 *   Sicherheits-Posture:
 *     - Keine Credentials werden gelesen, entschlüsselt oder geloggt.
 *     - `hasCredential(provider, workspaceId)` ist ein reiner Existenz-Check
 *       (COUNT-Query ohne Decrypt). Er ist als separater Helfer dokumentiert
 *       und dem Caller überlassen (siehe unten: "Credential-Check-Hinweis").
 *     - Dieses Modul importiert die DB NUR für `listConnectors()` / `getConnectorProfile()`
 *       (platform-globaler Katalog, keine sensitiven Daten, D1).
 *
 * Abhängigkeiten:
 *   lib/connectors/catalog.ts — listConnectors, getConnectorProfile, listCapabilities.
 *   Keine weiteren Imports (kein vault, kein LLM, kein I/O im Default-Pfad).
 */

import {
  listConnectors,
  getConnectorProfile,
  listCapabilities,
} from "@/lib/connectors/catalog";
import type { ConnectorCatalogRow, ConnectorCapabilityRow } from "@/db/schema/connectors";

// ---------------------------------------------------------------------------
// Öffentliche Typen
// ---------------------------------------------------------------------------

/**
 * Ergebnis von `detectConnector`.
 *
 * - `provider`           : gematchter Katalog-Provider-Slug (z.B. 'heygen'), oder null.
 * - `neededCapabilities` : grob aus der Anfrage abgeleitete Capability-Namen.
 * - `confidence`         : 0..1 — deterministisch aus Match-Art berechnet:
 *                            1.0 = exakter Provider-Name/Alias-Match im Katalog
 *                            0.7 = Keyword-Heuristik trifft auf Katalog-Provider
 *                            0.3 = Keyword-Heuristik ohne Katalog-Match ('no-connector')
 *                            0.0 = kein Signal
 * - `missing`            : Status des Providers/Credentials:
 *                            'none'          — Profil + Credential vorhanden (laut Caller-Context).
 *                            'credential'    — Profil bekannt, Credential unbekannt (Vault-Check fehlt).
 *                            'profile'       — Provider erkannt (Name/Alias gemeint), aber kein Katalog-Eintrag.
 *                            'no-connector'  — kein Connector-Bezug erkannt.
 * - `rationale`          : N8-taugliche Begründung (verbatim, kein Paraphrasieren).
 */
export interface ConnectorDetection {
  provider: string | null;
  neededCapabilities: string[];
  confidence: number;
  missing: "profile" | "credential" | "none" | "no-connector";
  rationale: string;
}

/**
 * Caller-Context für `detectConnector`.
 *
 * - `workspaceId`  : Pflicht — für zukünftige Credential-Checks (ACL5-B/C).
 * - `hasCredential`: optionaler injizierter Check (empfohlen für ACL5-C-Integration).
 *                   Wenn nicht übergeben, wird `missing` konservativ als 'credential'
 *                   gesetzt (kein Credential-Wissen → fail-closed ≠ 'none').
 *
 * Credential-Check-Hinweis:
 *   Der Caller kann einen leichten "hasCredential(provider, workspaceId)"-Check
 *   injizieren. Dieser DARF NICHT entschlüsseln — nur Existenz prüfen:
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
 *   Das intentionale Design: `detect.ts` selbst macht keinen DB-Call auf api_credentials
 *   (vault). Damit bleibt das Modul ohne Abhängigkeit auf den Credential-Pfad und ist
 *   in Tests ohne vault-Mock benutzbar.
 */
export interface DetectContext {
  workspaceId: string;
  hasCredential?: (provider: string) => boolean;
}

// ---------------------------------------------------------------------------
// Keyword → Capability-Heuristik-Tabelle
//
// Bildet generische Domänen-Begriffe (DE + EN) auf grobe Capability-Namen ab.
// Diese Heuristik ist DETERMINISTISCH — keine Gewichtung, kein LLM.
// Die Capability-Namen hier sind kanonische Beispiele; `detectConnector` gleicht
// sie NICHT gegen den Katalog ab (das ist Sache des Callers via validateCoverage).
//
// Reihenfolge: spezifischere Patterns oben.
// ---------------------------------------------------------------------------

interface KeywordRule {
  /** Regex-Pattern (case-insensitive, global-Flag wird intern gesetzt). */
  pattern: RegExp;
  /** Capability-Namen die dieses Keyword impliziert. */
  capabilities: string[];
  /** Optional: Provider-Hint — wenn gesetzt, wird dieser als Provider-Kandidat geprüft. */
  providerHint?: string;
}

const KEYWORD_RULES: KeywordRule[] = [
  // Video-Rendering / Avatare
  {
    pattern: /\b(video|render|avatar|heygen|talking.head|sprechender?\s+kopf)\b/i,
    capabilities: ["render_video", "list_avatars"],
    providerHint: "heygen",
  },
  // Bild-Generierung
  {
    pattern:
      /\b(image.gen|bild.generi|dall-?e|midjourney|stable.diffusion|generate.image|bild.erstell)\b/i,
    capabilities: ["generate_image"],
  },
  // E-Mail-Versand
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
  // Social Media — allgemein
  {
    pattern:
      /\b(social.media|poste.auf|post.to|veröffentliche.auf|schedule.post|content.planen)\b/i,
    capabilities: ["post_media"],
  },
  // Payment / Zahlungen
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
  // Storage / Dateien
  {
    pattern: /\b(upload|datei.hochlad|file.upload|s3|storage|bucket)\b/i,
    capabilities: ["upload_file", "list_files"],
  },
  // CRM / Kontakte
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
  // Google Sheets / Tabellen
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
// Haupt-Funktion: detectConnector (N6 deterministisch — kein LLM, kein async)
// ---------------------------------------------------------------------------

/**
 * Erkennt deterministisch, welcher externe Connector/Provider für einen
 * Chat-Prompt gebraucht wird.
 *
 * Ablauf:
 *   1. Normalisierung: lowercase-Trim des Prompts.
 *   2. Provider-Name/Alias-Match: Prüft, ob ein Katalog-Provider-Slug oder
 *      `displayName` direkt im Prompt vorkommt (exakter Match, word-boundary).
 *      Bei Treffer: confidence = 1.0.
 *   3. Keyword-Heuristik: Prüft alle KEYWORD_RULES gegen den Prompt.
 *      Bei Treffer: `providerHint` gegen Katalog; confidence = 0.7 (Katalog-Hit)
 *      oder 0.3 (kein Katalog-Hit).
 *   4. Kein Signal: provider = null, missing = 'no-connector', confidence = 0.
 *
 * N6: deterministisch — gleicher Input → gleicher Output (keine Stochastik).
 * N8: `rationale` dokumentiert den Entscheidungspfad verbatim.
 * Kein LLM, kein I/O auf api_credentials (kein Vault-Zugriff).
 *
 * @param prompt  - Der rohe Chat-Prompt (beliebige Länge, DE oder EN).
 * @param ctx     - Caller-Context: workspaceId + optionaler hasCredential-Check.
 * @returns       ConnectorDetection (immer ein Wert, nie null/undefined).
 */
export function detectConnector(
  prompt: string,
  ctx: DetectContext,
): ConnectorDetection {
  const normalized = prompt.toLowerCase().trim();

  // ── 1. Provider-Name/Alias-Match gegen listConnectors() ──────────────────
  //
  // Lädt alle Katalog-Einträge (platform-global, kein scope, kein Credential).
  // Prüft ob provider-Slug oder displayName (lowercase) als Word-Boundary im
  // normalisierten Prompt vorkommt.
  //
  // Vorteil: providerHint-Heuristik braucht den Katalog nur einmal.
  // Performance: listConnectors() nutzt getDb() → synchron, kein Netzwerk.

  const catalogRows = loadCatalogSafe();

  for (const row of catalogRows) {
    const slugPattern = buildWordBoundaryPattern(row.provider);
    const displayPattern = buildWordBoundaryPattern(row.displayName.toLowerCase());

    if (slugPattern.test(normalized) || displayPattern.test(normalized)) {
      // Exakter Katalog-Match
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

  // ── 2. Keyword-Heuristik ──────────────────────────────────────────────────
  //
  // Prüft KEYWORD_RULES in Reihenfolge (spezifischste zuerst).
  // Erster Treffer gewinnt (konservativ: kein Multi-Match fan-out).

  for (const rule of KEYWORD_RULES) {
    const re = new RegExp(rule.pattern.source, "gi");
    const match = re.exec(normalized);

    if (match !== null) {
      const matchedText = match[0];
      const hintProvider = rule.providerHint ?? null;

      // Prüfe ob der providerHint im Katalog existiert
      const catalogRow = hintProvider ? getCatalogRowSafe(hintProvider) : null;

      if (catalogRow !== null) {
        // Keyword + Katalog-Hit: confidence 0.7
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
        // Provider-Hint erkannt aber NICHT im Katalog: missing='profile'
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

      // Keyword ohne Provider-Hint: kein konkreter Provider, aber Capability-Signal
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

  // ── 3. Kein Signal ────────────────────────────────────────────────────────

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
// Interne Hilfsfunktionen (pure, keine Seiteneffekte außer DB-Reads)
// ---------------------------------------------------------------------------

/**
 * Lädt alle Katalog-Zeilen sicher. Gibt leeres Array zurück wenn die DB
 * nicht erreichbar ist (z.B. in Unit-Tests ohne DB-Mock).
 *
 * N6: fail-safe — kein Crash wenn DB nicht verfügbar.
 */
function loadCatalogSafe(): ConnectorCatalogRow[] {
  try {
    return listConnectors();
  } catch {
    return [];
  }
}

/**
 * Holt einen einzelnen Katalog-Eintrag sicher.
 * Gibt null zurück bei Fehler oder fehlendem Eintrag.
 */
function getCatalogRowSafe(provider: string): ConnectorCatalogRow | null {
  try {
    return getConnectorProfile(provider);
  } catch {
    return null;
  }
}

/**
 * Extrahiert Capability-Namen für einen Provider aus dem Katalog.
 * Gibt leeres Array zurück bei Fehler oder fehlendem Eintrag.
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
 * Baut ein Word-Boundary-Pattern für einen Begriff.
 * Escapet Regex-Sonderzeichen im Begriff (z.B. für "google-calendar").
 *
 * Anmerkung: Word-Boundary \b funktioniert nicht zuverlässig bei Sonderzeichen
 * wie Bindestrichen. Daher: (?<![a-z0-9]) + Begriff + (?![a-z0-9]) als
 * alternatives Boundary-Muster für Provider-Slugs mit Bindestrichen.
 */
function buildWordBoundaryPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Für Provider-Slugs mit Bindestrichen: keine echten Wortgrenzen nötig,
  // wir suchen nur ob der Begriff als Substring (kontextuell isoliert) vorkommt.
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

/**
 * Mergt zwei Capability-Listen ohne Duplikate (Reihenfolge: heuristisch zuerst,
 * dann Katalog-Caps die noch nicht in der heuristischen Liste sind).
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
 * Bestimmt den `missing`-Status deterministisch.
 *
 * - Wenn `ctx.hasCredential` injiziert ist: prüft Existenz via Callback.
 * - Wenn `ctx.hasCredential` NICHT injiziert ist: konservativ 'credential'
 *   (wir wissen nicht ob ein Credential existiert → fail-closed, kein 'none').
 *
 * N6: deterministisch, kein I/O direkt in diesem Modul.
 */
function resolveMissingStatus(
  provider: string,
  ctx: DetectContext,
  _matchType: "catalogHit" | "keywordCatalogHit",
): "none" | "credential" {
  if (ctx.hasCredential !== undefined) {
    return ctx.hasCredential(provider) ? "none" : "credential";
  }
  // Kein hasCredential-Callback: konservativ 'credential' (wir wissen es nicht)
  return "credential";
}

// ---------------------------------------------------------------------------
// Optionaler LLM-Fallback — SEPARATE Funktion, NICHT im Hot-Path-Default.
//
// Diese Funktion wird von `detectConnector()` NICHT aufgerufen.
// Der Caller muss sie explizit aufrufen, wenn die deterministische Erkennung
// unzureichend ist (confidence < Schwelle oder missing='no-connector').
//
// WICHTIG: Diese Funktion ist ein Stub. Die tatsächliche LLM-Integration
// (via lazyOS-Orchestrator / Codex) liegt außerhalb dieses Moduls.
// Sie ist hier ausschließlich als klar benannter Einstiegspunkt dokumentiert,
// damit künftige Implementierungen ihn finden und die Trennung Hot-Path vs.
// LLM-Fallback nicht versehentlich aufheben.
// ---------------------------------------------------------------------------

/**
 * Optionaler LLM-Klassifikations-Fallback.
 *
 * NICHT im Hot-Path von detectConnector(). Nur aufrufen wenn:
 *   1. detectConnector() liefert missing='no-connector' oder confidence < 0.5.
 *   2. Der Caller kann auf LLM-Kosten verzichten.
 *
 * Stub: gibt denselben `fallback`-Wert zurück den der Caller übergibt.
 * Ersetze den Body durch echten LLM-Call wenn ACL5-E die Chat-Wiring
 * implementiert.
 *
 * @param _prompt   - Der originale Prompt.
 * @param fallback  - Ergebnis aus `detectConnector()` als Ausgangsbasis.
 * @param _ctx      - Caller-Context (workspaceId, hasCredential).
 * @returns         ConnectorDetection — der LLM kann `provider` und
 *                  `neededCapabilities` verfeinern; `rationale` MUSS
 *                  "LLM-Fallback: " als Präfix tragen (N8-tauglich).
 */
export function classifyWithLlmFallback(
  _prompt: string,
  fallback: ConnectorDetection,
  _ctx: DetectContext,
): ConnectorDetection {
  // STUB — echte LLM-Integration hier eintragen.
  // Bis zur Implementierung: deterministisches Ergebnis unverändert zurück.
  return {
    ...fallback,
    rationale: `LLM-Fallback (stub, nicht implementiert): ${fallback.rationale}`,
  };
}
