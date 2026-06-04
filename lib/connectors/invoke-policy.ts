/**
 * Connector Invoke-Policy Gate (S4, ACL-5-C — 2026-05-24).
 *
 * Deterministisches, fail-closed Tool-Hardening für Connector-Calls.
 * Adressiert S4 aus dem ACL-5-Auto-Connect-Plan:
 *   "baut hardened allowedTools strikt aus Connector-Capabilities ∩ binding-resolver
 *    ∩ K1-Deny; verbietet bash/file/andere-Provider"
 *
 * Komplementär zu lib/security/execution-policy.ts (R2 für Plan-Steps):
 *   - execution-policy.ts: plan-steps mit Rollen, file/bash-Tools, workspaceId.
 *   - invoke-policy.ts:    connector-calls mit Provider, Capabilities, MCP-Tools.
 *   Beide sind pure Funktionen (keine I/O, kein LLM, keine DB, kein child_process).
 *
 * Designprinzipien (identisch zu execution-policy.ts + binding-resolver.ts):
 *   - Keine Default-allow. Fehlende / unbekannte Felder → deny.
 *   - Pure Funktionen: keine DB, kein LLM, kein IO.
 *   - fail-closed: im Zweifel WENIGER Tools.
 *   - K1-Deny ist hart — nicht überschreibbar durch Allowlist.
 *   - N6: Deterministische Validatoren vor symbolischem Reasoning.
 *   - N1: reason verbatim, kein slice, kein Kürzen.
 *
 * Sicherheits-Constraints (S4):
 *   - allowedMcpTools = mcp_tool_names der Capabilities ∩ requestedCaps, MINUS K1-Deny.
 *   - KEINE File/Bash/Edit/Write/Read-Tools — Connector-Calls sind MCP-only.
 *   - KEINE Tools anderer Provider: Tool muss mit 'mcp__<provider>__' beginnen
 *     (Provider-Namespacing) oder muss explizit im Capability-Profil des Providers stehen.
 *   - Unbekannte Capability (nicht im Katalog-Profil) → assertCallAllowed wirft.
 *
 * K1-RAG-Deny-Patterns:
 *   Identisch zu binding-resolver.ts K1_RAG_DENY_PATTERNS (inlined für Audit-Klarheit).
 *   Ein K1-Match blockiert unüberwindbar — die Allowlist kann K1 nicht aufheben.
 */

import { matchesK1Deny } from "../routines/binding-resolver";

// ─────────────────────────────────────────────────────────────────────────────
// Public Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ein Connector-Capability-Profil, wie es aus listCapabilities() + getConnectorProfile()
 * zusammengestellt wird. Nur die für S4 relevanten Felder.
 */
export interface ConnectorCapabilityProfile {
  /** Capability-Name, z.B. 'render_video'. */
  name: string;
  /**
   * MCP-Tool-Name in kanonischer Form 'mcp__<server>__<tool>'.
   * NULL = Capability hat keine MCP-Entsprechung (REST-only).
   */
  mcpToolName: string | null;
}

/**
 * Das Connector-Profil, das an buildHardenedToolset übergeben wird.
 * Entspricht dem Subset aus ConnectorCatalogRow + ConnectorCapabilityRow[].
 */
export interface ConnectorProfile {
  /** Provider-Slug aus connector_catalog, z.B. 'heygen'. */
  provider: string;
  /** Alle bekannten Capabilities dieses Connectors. */
  capabilities: ConnectorCapabilityProfile[];
}

/**
 * Ergebnis von buildHardenedToolset.
 *
 * allowedMcpTools: STRIKT die MCP-Tool-Namen aus den Capabilities des Providers
 *   die (a) in requestedCaps enthalten sind UND (b) K1-Deny nicht matchen.
 * deniedMcpTools: Capabilities die K1-geblockt wurden oder keinen mcpToolName haben.
 * capabilityToTool: explizite Auflösung Capability-Name → konkreter erlaubter
 *   MCP-Tool-Name. NUR erlaubte (nicht denied) Capabilities tauchen hier auf.
 *   Dies ist die maßgebliche Quelle für assertCallAllowed — sie ist robust
 *   gegen Divergenz zwischen Capability-Name und Tool-Name (Finding 3a:
 *   reale Connectoren haben cap 'list_avatars' → tool 'mcp__heygen__avatars_list').
 * allowedFileTools: immer [] — Connector-Calls brauchen keine lokalen File-Tools.
 * rationale: Erklärung (N1), verbatim.
 */
export interface HardenedToolset {
  allowedMcpTools: string[];
  deniedMcpTools: string[];
  /**
   * Mapping erlaubte Capability → konkreter erlaubter MCP-Tool-Name.
   * Ein Eintrag existiert genau dann, wenn die Capability alle Gates (Profil,
   * mcpToolName, K1, Provider-Namespace) bestanden hat. assertCallAllowed prüft
   * `capability in capabilityToTool` (fail-closed: nicht enthalten → wirft).
   */
  capabilityToTool: Record<string, string>;
  allowedFileTools: readonly never[];
  rationale: string;
}

/**
 * Eingabe für assertCallAllowed.
 */
export interface CallAllowedArgs {
  /** Provider-Slug, z.B. 'heygen'. */
  provider: string;
  /** Capability-Name die aufgerufen werden soll, z.B. 'render_video'. */
  capability: string;
  /** Das gehärtete Toolset aus buildHardenedToolset. */
  hardened: HardenedToolset;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interne Konstanten (S4 Hardening)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * File/Bash-Tools die für Connector-Calls NIEMALS erlaubt sind.
 * Connector-Calls sind MCP-Calls gegen externe APIs — sie brauchen keine
 * lokalen Filesystem- oder Shell-Zugriffe. Ein solches Tool in einer Anfrage
 * ist entweder ein Programmierfehler oder ein Angriff.
 *
 * Dies ist defense-in-depth gegenüber execution-policy.ts (das ebenfalls
 * Bash blockiert), weil invoke-policy.ts einen völlig anderen Kontext hat:
 * hier gibt es keine "erlaubten Schreib-Rollen" — es gibt gar keine file-tools.
 */
const FORBIDDEN_FILE_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Shell",
  "Exec",
  "Grep",
  "Glob",
  "LS",
]);

// ─────────────────────────────────────────────────────────────────────────────
// buildHardenedToolset — pure, fail-closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Baut die strikt gehärtete Tool-Liste für einen Connector-Call.
 *
 * Algorithmus (fail-closed, in dieser Reihenfolge):
 *   1. provider muss nicht-leer sein.
 *   2. Für jede requestedCap (Capability-Name):
 *      a. Suche die Capability im Profil → nicht gefunden → denied (unbekannt → raus).
 *      b. mcpToolName vorhanden? Sonst → denied (REST-only Capability ohne MCP-Tool).
 *      c. K1-Deny Check (hart, nicht überschreibbar) → K1-match → denied.
 *      d. Provider-Namespace-Check: mcpToolName muss mit 'mcp__' beginnen
 *         UND 'mcp__<provider>__' als Präfix haben → sonst denied (falscher Provider).
 *      e. Alle Checks bestanden → allowed.
 *   3. File/Bash-Tools sind strukturell nie in allowedMcpTools enthalten
 *      (sie kommen nie aus Capability.mcpToolName rein).
 *
 * Pure Funktion: keine Side-Effects, keine DB, kein LLM, kein IO.
 *
 * @param provider       Provider-Slug, z.B. 'heygen'.
 * @param profile        Connector-Profil mit Capabilities.
 * @param requestedCaps  Capability-Namen die der Caller haben möchte.
 * @returns              HardenedToolset (immer, nie throws — assertCallAllowed wirft).
 */
export function buildHardenedToolset(
  provider: string,
  profile: ConnectorProfile,
  requestedCaps: readonly string[],
): HardenedToolset {
  // Schritt 1: provider-Pflicht.
  if (!provider || provider.trim().length === 0) {
    return {
      allowedMcpTools: [],
      deniedMcpTools: [],
      capabilityToTool: {},
      allowedFileTools: [],
      rationale:
        "Provider-Slug fehlt: Tool-Hardening erfordert einen Connector-Provider-Namen.",
    };
  }

  const trimmedProvider = provider.trim();

  // Schritt 2: requestedCaps leer → leeres Toolset (nicht denied, einfach leer).
  if (requestedCaps.length === 0) {
    return {
      allowedMcpTools: [],
      deniedMcpTools: [],
      capabilityToTool: {},
      allowedFileTools: [],
      rationale: `Keine Capabilities angefordert für Provider '${trimmedProvider}'.`,
    };
  }

  // Capability-Lookup: name → Capability
  const capabilityMap = new Map<string, ConnectorCapabilityProfile>();
  for (const cap of profile.capabilities) {
    capabilityMap.set(cap.name, cap);
  }

  const allowedMcpTools: string[] = [];
  const deniedMcpTools: string[] = [];
  const deniedReasons: string[] = [];
  // Finding 3a: explizite Auflösung Capability-Name → erlaubter MCP-Tool-Name.
  // Nur erlaubte Capabilities landen hier. Robust gegen Name-Divergenz.
  const capabilityToTool: Record<string, string> = {};

  // Provider-Namespace-Präfix für den Check.
  // MCP-Tools dieses Providers müssen mit 'mcp__<provider>__' beginnen.
  const expectedPrefix = `mcp__${trimmedProvider}__`;

  for (const capName of requestedCaps) {
    // (a) Capability im Profil vorhanden?
    const cap = capabilityMap.get(capName);
    if (!cap) {
      deniedMcpTools.push(capName);
      deniedReasons.push(
        `Capability '${capName}' nicht im Profil von Provider '${trimmedProvider}' — unbekannt → raus (fail-closed).`,
      );
      continue;
    }

    // (b) Hat diese Capability einen MCP-Tool-Namen?
    const toolName = cap.mcpToolName;
    if (!toolName || toolName.trim().length === 0) {
      deniedMcpTools.push(capName);
      deniedReasons.push(
        `Capability '${capName}' hat keinen MCP-Tool-Namen (REST-only?) — kein MCP-Tool verfügbar.`,
      );
      continue;
    }

    const trimmedTool = toolName.trim();

    // (c) K1-Deny — hart, nicht überschreibbar.
    if (matchesK1Deny(trimmedTool)) {
      deniedMcpTools.push(trimmedTool);
      deniedReasons.push(
        `K1-Hard-Block: MCP-Tool '${trimmedTool}' für Capability '${capName}' matcht K1-RAG-Deny-Pattern — Blocking ist unüberschreibbar.`,
      );
      continue;
    }

    // (d) Provider-Namespace-Check: Tool muss zum Provider gehören.
    // Verhindert dass Capabilities eines Providers auf Tools eines anderen Providers
    // zeigen (z.B. 'mcp__malicious__exfiltrate' in einem heygen-Profil).
    if (!trimmedTool.startsWith(expectedPrefix)) {
      deniedMcpTools.push(trimmedTool);
      deniedReasons.push(
        `Provider-Namespace-Verletzung: MCP-Tool '${trimmedTool}' gehört nicht zum Provider '${trimmedProvider}' ` +
          `(erwartet Präfix '${expectedPrefix}') — cross-Provider-Tool-Injektion blockiert.`,
      );
      continue;
    }

    // (e) Alle Checks bestanden — Tool ist erlaubt.
    allowedMcpTools.push(trimmedTool);
    // Finding 3a: Capability-Name explizit auf den konkreten Tool-Namen mappen.
    // Damit ist assertCallAllowed unabhängig von einer Tail-Heuristik.
    capabilityToTool[capName] = trimmedTool;
  }

  const rationale =
    allowedMcpTools.length > 0
      ? `S4-Hardening für '${trimmedProvider}': ${allowedMcpTools.length} Tool(s) erlaubt` +
        (deniedMcpTools.length > 0
          ? `, ${deniedMcpTools.length} geblockt (${deniedReasons[0] ?? ""})`
          : ".") +
        " File/Bash-Tools strukturell nie erlaubt (Connector-Calls = MCP-only)."
      : `S4-Hardening für '${trimmedProvider}': alle angeforderten Tools blockiert.` +
        (deniedReasons.length > 0 ? ` Erster Grund: ${deniedReasons[0]}` : "");

  return {
    allowedMcpTools,
    deniedMcpTools,
    capabilityToTool,
    allowedFileTools: [],
    rationale,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// assertCallAllowed — fail-closed Guard (wirft bei Deny)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assertiert dass eine Capability in dem gehärteten Toolset erlaubt ist.
 *
 * Finding 3a: Die Auflösung Capability → MCP-Tool-Name wurde von
 * buildHardenedToolset EXPLIZIT in `hardened.capabilityToTool` gespeichert.
 * assertCallAllowed prüft daher `capability in capabilityToTool` — kein
 * Tail-Heuristik-Match mehr. Damit funktioniert das Gate auch wenn
 * Capability-Name und Tool-Name divergieren (z.B. cap 'list_avatars' →
 * tool 'mcp__heygen__avatars_list').
 *
 * Zusätzlich (defense-in-depth) wird verifiziert, dass der aufgelöste Tool-Name
 * tatsächlich in allowedMcpTools steht und zum Provider gehört — eine
 * manipulierte Map kann das Gate also nicht aufweichen.
 *
 * Fail-closed: bei jeder Unklarheit wird geworfen.
 *
 * @throws {CallDeniedError} wenn die Capability nicht erlaubt ist.
 */
export function assertCallAllowed(
  provider: string,
  capability: string,
  hardened: HardenedToolset,
): void {
  const trimmedProvider = (provider ?? "").trim();
  const trimmedCap = (capability ?? "").trim();

  if (!trimmedProvider || !trimmedCap) {
    throw new CallDeniedError(
      `assertCallAllowed: Provider-Slug und Capability-Name dürfen nicht leer sein.`,
      "missing-args",
    );
  }

  // Defensiv: capabilityToTool kann bei einem fehlerhaft konstruierten Toolset
  // fehlen (z.B. ältere Caller). Fail-closed: ohne Map → keine Auflösung möglich.
  const capabilityToTool = hardened.capabilityToTool ?? {};

  if (hardened.allowedMcpTools.length === 0) {
    throw new CallDeniedError(
      `assertCallAllowed: Keine erlaubten MCP-Tools im gehärteten Toolset für Provider '${trimmedProvider}'. ` +
        `Capability '${trimmedCap}' ist nicht erlaubt. Grund: ${hardened.rationale}`,
      "no-allowed-tools",
    );
  }

  // Provider-Konsistenz: das gehärtete Toolset muss überhaupt Tools für diesen
  // Provider enthalten. Verhindert dass ein Toolset für Provider A einen Call
  // für Provider B durchwinkt.
  const expectedPrefix = `mcp__${trimmedProvider}__`;
  const relevantAllowed = hardened.allowedMcpTools.filter((t) =>
    t.startsWith(expectedPrefix),
  );

  if (relevantAllowed.length === 0) {
    throw new CallDeniedError(
      `assertCallAllowed: Keine erlaubten MCP-Tools für Provider '${trimmedProvider}' ` +
        `in gehärtetem Toolset. Capability '${trimmedCap}' ist nicht erlaubt. ` +
        `Gesamtes gehärtetes Toolset: [${hardened.allowedMcpTools.join(", ")}]. ` +
        `Rationale: ${hardened.rationale}`,
      "provider-not-in-hardened",
    );
  }

  // Maßgebliche Auflösung (Finding 3a): ist die Capability als erlaubt aufgelöst?
  // Eigenes Property (kein Prototype-Walk) prüfen, dann den aufgelösten Tool-Namen
  // gegen allowedMcpTools + Provider-Namespace re-verifizieren (defense-in-depth
  // gegen eine manipulierte Map).
  const resolvedTool = Object.prototype.hasOwnProperty.call(capabilityToTool, trimmedCap)
    ? capabilityToTool[trimmedCap]
    : undefined;

  if (
    !resolvedTool ||
    !relevantAllowed.includes(resolvedTool) ||
    !resolvedTool.startsWith(expectedPrefix)
  ) {
    throw new CallDeniedError(
      `assertCallAllowed: Capability '${trimmedCap}' für Provider '${trimmedProvider}' ` +
        `ist nicht im gehärteten Toolset aufgelöst. ` +
        `Erlaubte Capabilities: [${Object.keys(capabilityToTool).join(", ")}]. ` +
        `Bitte buildHardenedToolset mit Capability '${trimmedCap}' in requestedCaps aufrufen. ` +
        `Fail-closed: kein Call ohne explizite Capability-Auflösung.`,
      "capability-not-resolved",
    );
  }

  // Capability → Tool ist explizit aufgelöst, das Tool steht in allowedMcpTools
  // und gehört zum Provider-Namespace → erlaubt.
}

// ─────────────────────────────────────────────────────────────────────────────
// CallDeniedError — spezifischer Fehler-Typ für fail-closed Denys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wird von assertCallAllowed geworfen wenn ein Connector-Call blockiert wird.
 *
 * code-Feld erlaubt dem Caller (trust.ts, ACL5-D executor) die Deny-Ursache
 * zu unterscheiden für N8-Audit-Zwecke ohne den Fehler-Text parsen zu müssen.
 */
export class CallDeniedError extends Error {
  readonly code:
    | "missing-args"
    | "no-allowed-tools"
    | "provider-not-in-hardened"
    | "capability-not-resolved";

  constructor(
    message: string,
    code: CallDeniedError["code"],
  ) {
    super(message);
    this.name = "CallDeniedError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// hasFileToolInRequest — pure Hilfsfunktion für Tests + Verteidigungslinie
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prüft ob eine Liste von Tool-Namen ein File/Bash-Tool enthält.
 * Wird von Tests verwendet um sicherzustellen dass buildHardenedToolset nie
 * ein File/Bash-Tool in allowedMcpTools liefert.
 *
 * Pure Hilfsfunktion.
 */
export function hasFileTool(tools: readonly string[]): boolean {
  return tools.some((t) => FORBIDDEN_FILE_TOOLS.has(t));
}
