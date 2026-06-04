/**
 * G2 — No-auto-run-Gate-Matrix (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Master-Briefing §7.2 (verbatim, N1):
 *   „Imported context must not auto-run."
 *
 * Master-Briefing §13.2 (verbatim, N1):
 *   „Opt-in · Transparenz · Zweckbindung · Datenminimierung · Pause/Stop
 *    jederzeit · Redaction · keine geheimen Screenshots · keine Passwörter ·
 *    keine privaten Daten · Review durch betroffene Person · Betriebsrat/
 *    Arbeitsrecht beachten"
 *
 * Diese Matrix ist die deterministische SPERRE, die JEDE andere Lane (Plan-
 * Execute, Connector-Invoke, Spawn, Persist-Belief, …) befragen MUSS, bevor
 * sie irgendetwas auto-startet. Sie ist die Stage-1-Foundation des
 * Governance Gate Contracts.
 *
 * Bauprinzip (analog lib/security/dataflow-policy.ts):
 *   - PURE Funktion: kein DB-Read, kein LLM, kein IO. Kann von jedem Caller
 *     ohne Setup-Aufwand befragt werden. Der HAS-CONSENT-Read (DB) wird
 *     EXPLIZIT als Eingabe übergeben — der Caller (z.B. plan-executor) muss
 *     vorher hasConsent(raw, ...) abrufen und das Ergebnis hereinreichen.
 *   - N6: deterministische Validatoren vor symbolischem Reasoning.
 *   - N1: reason verbatim — kein .slice.
 *
 * Mechanik:
 *   canAutoRun(args) → { ok, reason, missingGate? }
 *     - ok=true     → die Action darf OHNE weitere Approval ausgeführt werden
 *     - ok=false    → blockiert. missingGate beschreibt das fehlende Gate
 *                     ('consent:<level>' | 'human-approval' | 'audit' |
 *                      'permission-mode:freerein').
 *
 * NO_AUTO_RUN_RULES ist die Quelle der Wahrheit. Jede ActionKind hat:
 *   - allowedWithoutApproval: darf sie OHNE explizites OK laufen?
 *     (Default: false für alles Externe.)
 *   - requiresLevel:          minimaler ConsentLevel, falls dataSource
 *                             gegeben ist. 'none' = kein Consent nötig.
 *   - requiresHumanGate:      verlangt sie ein vorheriges User-Approval
 *                             (Bridge / Live-Warn-Ack / Permission-Mode)?
 *   - requiresAuditRow:       MUSS ein governance_audit-Eintrag geschrieben
 *                             werden?
 *   - requiresPermissionMode: erlaubte Permission-Modes (subset von
 *                             'freerein' | 'freerein-with-audit' | 'lane' |
 *                             'ask'). [] = keine Permission-Mode-Restriktion.
 */

import type { ConsentLevel } from "./consent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionKind =
  | "connector-invoke-live"
  | "spawn-subagent"
  | "plan-execute"
  | "persist-belief"
  | "send-external-message"
  | "fetch-external-url"
  | "execute-bash"
  | "fs-write";

export type PermissionMode = "freerein" | "freerein-with-audit" | "lane" | "ask";

export interface GateRule {
  readonly allowedWithoutApproval: boolean;
  readonly requiresLevel: ConsentLevel;
  readonly requiresHumanGate: boolean;
  readonly requiresAuditRow: boolean;
  /**
   * Wenn nicht-leer: nur in einem dieser Permission-Modes erlaubt. [] = keine
   * Permission-Mode-Restriktion.
   */
  readonly requiresPermissionMode: readonly PermissionMode[];
  /** VERBATIM Erklärung der Regel (N1). */
  readonly rationale: string;
}

export interface CanAutoRunArgs {
  readonly workspaceId: string;
  readonly userId: string;
  readonly action: ActionKind;
  /** Nur relevant bei daten-bezogenen Actions. */
  readonly dataSource?: string;
  /**
   * Der Caller hat hasConsent() bereits abgefragt und reicht das Ergebnis
   * hier rein. canAutoRun ist eine pure Funktion und liest die DB nicht.
   */
  readonly hasConsent?: boolean;
  /**
   * Hat der User vorher manuell zugestimmt (Bridge / Live-Warn-Ack /
   * Permission-Mode-Toggle)?
   */
  readonly humanApproved?: boolean;
  /** Der aktuelle Permission-Mode des Workspace. */
  readonly permissionMode?: PermissionMode;
}

export type MissingGate =
  | `consent:${ConsentLevel}`
  | "human-approval"
  | "audit"
  | `permission-mode:${PermissionMode | "freerein-family"}`
  | "data-source-missing";

export interface CanAutoRunResult {
  readonly ok: boolean;
  /** VERBATIM Erklärung (N1). */
  readonly reason: string;
  readonly missingGate?: MissingGate;
}

// ---------------------------------------------------------------------------
// NO_AUTO_RUN_RULES — Owner-Direktive §7.2 + §13.2 in Code
// ---------------------------------------------------------------------------

/**
 * Default-Disziplin (Owner-Direktive §7.2 „Imported context must not auto-run"
 * + §13.2 Opt-in):
 *
 *   - Alles EXTERNE (connector-invoke-live, send-external-message,
 *     fetch-external-url) → braucht ConsentLevel ≥ read-derive-act,
 *     Human-Approval UND Audit-Row.
 *   - Bash + fs-write → braucht Permission-Mode ∈ {freerein,
 *     freerein-with-audit} (sonst „ask"/„lane" blockt). KEIN externer
 *     Consent nötig (kein dataSource-Bezug), aber Audit-Row Pflicht.
 *   - INTERNAL-ONLY (persist-belief, spawn-subagent, plan-execute):
 *     ohne Approval erlaubt — sie lesen + schreiben innerhalb des
 *     Workspace-Scopes und können keinen externen Effekt haben.
 *     plan-execute fordert dennoch Audit (N8), weil es nachgelagerte Steps
 *     beinhalten kann.
 */
export const NO_AUTO_RUN_RULES: Record<ActionKind, GateRule> = {
  "connector-invoke-live": {
    allowedWithoutApproval: false,
    requiresLevel: "read-derive-act",
    requiresHumanGate: true,
    requiresAuditRow: true,
    requiresPermissionMode: [],
    rationale:
      "Externe Connector-Calls (LIVE) erzeugen messbare Außenwirkung (Kosten, " +
      "API-Limits, Datenfluss zum Provider). §7.2 + §13.2: Opt-in + explizites " +
      "User-OK + Audit-Row.",
  },
  "send-external-message": {
    allowedWithoutApproval: false,
    requiresLevel: "read-derive-act",
    requiresHumanGate: true,
    requiresAuditRow: true,
    requiresPermissionMode: [],
    rationale:
      "Ausgehende Nachrichten an Dritte (WhatsApp, Telegram, E-Mail). §13.2 " +
      "Review durch betroffene Person — Versand braucht explizites OK.",
  },
  "fetch-external-url": {
    allowedWithoutApproval: false,
    requiresLevel: "read-derive",
    requiresHumanGate: true,
    requiresAuditRow: true,
    requiresPermissionMode: [],
    rationale:
      "Beliebige URL-Fetches sind ein Datenfluss-Vektor (Exfiltration via " +
      "Query-Params). §7.2 Imported context must not auto-run.",
  },
  "execute-bash": {
    allowedWithoutApproval: false,
    requiresLevel: "none",
    requiresHumanGate: false,
    requiresAuditRow: true,
    requiresPermissionMode: ["freerein", "freerein-with-audit"],
    rationale:
      "Bash-Ausführung ist destruktiv und benötigt einen ausdrücklichen " +
      "Permission-Mode der Free-Rein-Familie (Owner-Toggle). Audit Pflicht.",
  },
  "fs-write": {
    allowedWithoutApproval: false,
    requiresLevel: "none",
    requiresHumanGate: false,
    requiresAuditRow: true,
    requiresPermissionMode: ["freerein", "freerein-with-audit"],
    rationale:
      "Schreibender Filesystem-Zugriff verändert User-Daten. Wie execute-bash " +
      "an die Free-Rein-Permission-Mode-Familie gebunden + Audit Pflicht.",
  },
  "plan-execute": {
    allowedWithoutApproval: true,
    requiresLevel: "none",
    requiresHumanGate: false,
    requiresAuditRow: true,
    requiresPermissionMode: [],
    rationale:
      "Plan-Execute selbst (FSM-Transition) ist intern; einzelne Steps " +
      "rufen ggf. weitere Regeln auf (rekursiv canAutoRun pro Step). " +
      "Audit-Row für Trace-Evidence (N8).",
  },
  "spawn-subagent": {
    allowedWithoutApproval: true,
    requiresLevel: "none",
    requiresHumanGate: false,
    requiresAuditRow: false,
    requiresPermissionMode: [],
    rationale:
      "Sub-Agent-Spawn ist internal-only; der Sub-Agent erbt den Scope vom " +
      "Parent (dataflow-policy.ts sub-agent-Rule). Keine externe Auswirkung.",
  },
  "persist-belief": {
    allowedWithoutApproval: true,
    requiresLevel: "none",
    requiresHumanGate: false,
    requiresAuditRow: false,
    requiresPermissionMode: [],
    rationale:
      "Belief-Persistierung in workspace_beliefs ist workspace-internal " +
      "(N9 ManifestCoord-Scope). Kein externer Datenfluss.",
  },
};

// ---------------------------------------------------------------------------
// canAutoRun — pure Funktion, deterministisch (N6)
// ---------------------------------------------------------------------------

/**
 * Trifft die Allow/Deny-Entscheidung für eine Action. KEIN DB-Read — die
 * benötigten Read-Ergebnisse (hasConsent, humanApproved, permissionMode)
 * werden vom Caller mitgeliefert.
 *
 * Reihenfolge der Checks (fail-closed bei jedem Fehlschlag):
 *   1. action muss bekannt sein (sonst deny: 'unknown action').
 *   2. Permission-Mode-Restriktion erfüllt?
 *   3. ConsentLevel ≥ required? (nur wenn requiresLevel !== 'none')
 *   4. Human-Approval da? (nur wenn requiresHumanGate)
 *   5. Wenn allowedWithoutApproval=false UND nichts der obigen Gates fehlt
 *      → erlaubt (Audit MUSS der Caller schreiben — der reason verweist
 *      darauf).
 */
export function canAutoRun(args: CanAutoRunArgs): CanAutoRunResult {
  if (!args || typeof args.action !== "string") {
    return {
      ok: false,
      reason: "canAutoRun: action required",
      missingGate: "human-approval",
    };
  }

  const rule = NO_AUTO_RUN_RULES[args.action as ActionKind];
  if (!rule) {
    return {
      ok: false,
      reason:
        `canAutoRun: unknown ActionKind '${String(args.action)}' — fail-closed ` +
        `(Owner-Direktive §7.2: „Imported context must not auto-run").`,
      missingGate: "human-approval",
    };
  }

  if (
    typeof args.workspaceId !== "string" ||
    args.workspaceId.length === 0 ||
    typeof args.userId !== "string" ||
    args.userId.length === 0
  ) {
    return {
      ok: false,
      reason: "canAutoRun: workspaceId + userId required",
      missingGate: "human-approval",
    };
  }

  // (2) Permission-Mode-Restriktion.
  if (rule.requiresPermissionMode.length > 0) {
    if (!args.permissionMode || !rule.requiresPermissionMode.includes(args.permissionMode)) {
      const required = rule.requiresPermissionMode.join(" | ");
      return {
        ok: false,
        reason:
          `Action '${args.action}' verlangt Permission-Mode ∈ {${required}}; ` +
          `aktuell '${args.permissionMode ?? "<none>"}'. ${rule.rationale}`,
        missingGate: "permission-mode:freerein-family",
      };
    }
  }

  // (3) ConsentLevel-Check (nur wenn nicht 'none').
  if (rule.requiresLevel !== "none") {
    if (typeof args.dataSource !== "string" || args.dataSource.length === 0) {
      return {
        ok: false,
        reason:
          `Action '${args.action}' braucht ConsentLevel ≥ '${rule.requiresLevel}', ` +
          `aber dataSource fehlt — fail-closed.`,
        missingGate: "data-source-missing",
      };
    }
    if (!args.hasConsent) {
      return {
        ok: false,
        reason:
          `Action '${args.action}' für dataSource '${args.dataSource}' verlangt ` +
          `ConsentLevel ≥ '${rule.requiresLevel}'. ${rule.rationale}`,
        missingGate: `consent:${rule.requiresLevel}`,
      };
    }
  }

  // (4) Human-Approval.
  if (rule.requiresHumanGate && !args.humanApproved) {
    return {
      ok: false,
      reason:
        `Action '${args.action}' verlangt explizites Human-Approval (Bridge / ` +
        `Live-Warn-Ack / Permission-Mode-Toggle). ${rule.rationale}`,
      missingGate: "human-approval",
    };
  }

  // (5) Allowed-without-approval? Default false; ok wenn alles vorhanden ist.
  // requiresAuditRow signalisiert dem Caller, dass er writeGovernanceAudit
  // schreiben MUSS — die Verantwortung liegt beim Caller, der reason erklärt
  // es verbatim.
  const auditNote = rule.requiresAuditRow
    ? " Caller MUSS writeGovernanceAudit() aufrufen (N8)."
    : "";

  return {
    ok: true,
    reason: `Action '${args.action}' erlaubt: ${rule.rationale}${auditNote}`,
  };
}
