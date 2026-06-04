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
 * This matrix is the deterministic LOCK that EVERY other lane (plan-
 * execute, connector-invoke, spawn, persist-belief, …) MUST query before
 * it auto-starts anything. It is the Stage-1 foundation of the
 * Governance Gate Contract.
 *
 * Design principle (analogous to lib/security/dataflow-policy.ts):
 *   - PURE function: no DB read, no LLM, no IO. Can be queried by any caller
 *     without setup overhead. The HAS-CONSENT read (DB) is passed in
 *     EXPLICITLY as input — the caller (e.g. plan-executor) must
 *     call hasConsent(raw, ...) beforehand and pass the result in.
 *   - N6: deterministic validators before symbolic reasoning.
 *   - N1: reason verbatim — no .slice.
 *
 * Mechanics:
 *   canAutoRun(args) → { ok, reason, missingGate? }
 *     - ok=true     → the action may run WITHOUT further approval
 *     - ok=false    → blocked. missingGate describes the missing gate
 *                     ('consent:<level>' | 'human-approval' | 'audit' |
 *                      'permission-mode:freerein').
 *
 * NO_AUTO_RUN_RULES is the source of truth. Every ActionKind has:
 *   - allowedWithoutApproval: may it run WITHOUT an explicit OK?
 *     (Default: false for everything external.)
 *   - requiresLevel:          minimum ConsentLevel, if dataSource is
 *                             given. 'none' = no consent needed.
 *   - requiresHumanGate:      does it require a prior user approval
 *                             (Bridge / Live-Warn-Ack / Permission-Mode)?
 *   - requiresAuditRow:       MUST a governance_audit entry be
 *                             written?
 *   - requiresPermissionMode: allowed permission modes (subset of
 *                             'freerein' | 'freerein-with-audit' | 'lane' |
 *                             'ask'). [] = no permission-mode restriction.
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
   * If non-empty: only allowed in one of these permission modes. [] = no
   * permission-mode restriction.
   */
  readonly requiresPermissionMode: readonly PermissionMode[];
  /** VERBATIM explanation of the rule (N1). */
  readonly rationale: string;
}

export interface CanAutoRunArgs {
  readonly workspaceId: string;
  readonly userId: string;
  readonly action: ActionKind;
  /** Only relevant for data-related actions. */
  readonly dataSource?: string;
  /**
   * The caller has already queried hasConsent() and passes the result
   * in here. canAutoRun is a pure function and does not read the DB.
   */
  readonly hasConsent?: boolean;
  /**
   * Has the user manually approved beforehand (Bridge / Live-Warn-Ack /
   * Permission-Mode toggle)?
   */
  readonly humanApproved?: boolean;
  /** The current permission mode of the workspace. */
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
  /** VERBATIM explanation (N1). */
  readonly reason: string;
  readonly missingGate?: MissingGate;
}

// ---------------------------------------------------------------------------
// NO_AUTO_RUN_RULES — owner directive §7.2 + §13.2 in code
// ---------------------------------------------------------------------------

/**
 * Default discipline (owner directive §7.2 „Imported context must not auto-run"
 * + §13.2 opt-in):
 *
 *   - Everything EXTERNAL (connector-invoke-live, send-external-message,
 *     fetch-external-url) → needs ConsentLevel ≥ read-derive-act,
 *     human approval AND an audit row.
 *   - Bash + fs-write → needs permission mode ∈ {freerein,
 *     freerein-with-audit} (otherwise „ask"/„lane" blocks). NO external
 *     consent needed (no dataSource relation), but an audit row is mandatory.
 *   - INTERNAL-ONLY (persist-belief, spawn-subagent, plan-execute):
 *     allowed without approval — they read + write within the
 *     workspace scope and can have no external effect.
 *     plan-execute still requires an audit (N8), because it can
 *     involve downstream steps.
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
// canAutoRun — pure function, deterministic (N6)
// ---------------------------------------------------------------------------

/**
 * Makes the allow/deny decision for an action. NO DB read — the
 * required read results (hasConsent, humanApproved, permissionMode)
 * are supplied by the caller.
 *
 * Order of the checks (fail-closed on every failure):
 *   1. action must be known (otherwise deny: 'unknown action').
 *   2. permission-mode restriction satisfied?
 *   3. ConsentLevel ≥ required? (only if requiresLevel !== 'none')
 *   4. human approval present? (only if requiresHumanGate)
 *   5. If allowedWithoutApproval=false AND none of the above gates is missing
 *      → allowed (the caller MUST write the audit — the reason points
 *      to it).
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

  // (2) Permission-mode restriction.
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

  // (3) ConsentLevel check (only if not 'none').
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

  // (4) Human approval.
  if (rule.requiresHumanGate && !args.humanApproved) {
    return {
      ok: false,
      reason:
        `Action '${args.action}' verlangt explizites Human-Approval (Bridge / ` +
        `Live-Warn-Ack / Permission-Mode-Toggle). ${rule.rationale}`,
      missingGate: "human-approval",
    };
  }

  // (5) Allowed-without-approval? Default false; ok if everything is present.
  // requiresAuditRow signals to the caller that it MUST write
  // writeGovernanceAudit — the responsibility lies with the caller, the reason
  // explains it verbatim.
  const auditNote = rule.requiresAuditRow
    ? " Caller MUSS writeGovernanceAudit() aufrufen (N8)."
    : "";

  return {
    ok: true,
    reason: `Action '${args.action}' erlaubt: ${rule.rationale}${auditNote}`,
  };
}
