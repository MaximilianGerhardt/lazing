/**
 * Pattern 2 Digital-Twin MVP — Prompt-Formatter.
 *
 * Kombiniert owner twin (User) und Domain-Twin (Workspace) in zwei kompakte
 * JSON-Blöcke mit XML-Wrappern, die der Sub-Agent eindeutig parsen kann:
 *
 *   <TWIN_USER>{...}</TWIN_USER>
 *   <TWIN_DOMAIN>{...}</TWIN_DOMAIN>
 *
 * Vorher (Sub-Agent las CLAUDE.md+MEMORY.md+Standards): ~10K Tokens.
 * Nachher (validierter JSON-Block): ≤500 Tokens.
 *
 * Fail-soft: bei fehlendem Twin → leerer String (Sub-Spawn fährt ungestört
 * weiter, bekommt halt keinen Twin-Block).
 */

import { getDomainTwin } from "./domain-twin";
import { getOwnerTwin } from "./owner-twin";
import { redactOwnerTwinForWorkspace } from "./redaction";

interface UserTwinPayload {
  stil: {
    sprache: string;
    ton: string;
    format_pref: string;
    duzen: boolean;
    max_woerter: number;
  };
  veto: string[];
  sensitive: string[];
  exit: string;
  projekte: Array<{ id: string; rolle: string; sensitivity?: "high" }>;
}

interface DomainTwinPayload {
  workspace: string;
  type: string | null;
  sensitivity: "low" | "high";
  accent: string | null;
  active_workstreams: number;
  recent_decisions: string[];
  open_tickets_p0_p1: number;
}

/**
 * Schätzung: ~4 Zeichen pro Token für Mixed-Content Englisch+Deutsch.
 * Genau genug für ein Soft-Budget-Assertion in Tests.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Kombinierter Twin-Block für System-Prompt-Injektion.
 * Liefert leeren String wenn beide Twins null sind.
 */
export async function formatTwinsForPrompt(
  workspaceId: string,
): Promise<string> {
  // Parallel laden — beide sind unabhängig.
  const [ownerTwin, domainTwin] = await Promise.all([
    getOwnerTwin(),
    getDomainTwin(workspaceId),
  ]);

  const blocks: string[] = [];

  if (ownerTwin) {
    // Privacy-Sprint V1 (2026-05-01): Workspace-aware Redaction.
    // In low-sensitivity-Workspaces (Kunden) werden private Themen +
    // high-sensitivity-Projekte aus dem Twin entfernt, BEVOR sie an
    // die LLM-Cloud geschickt werden. high-sensitivity-Workspaces
    // (User-eigene Trust-Zone) bekommen weiterhin den vollen Twin.
    const safeTwin = redactOwnerTwinForWorkspace(ownerTwin, domainTwin);
    const payload: UserTwinPayload = {
      stil: {
        sprache: safeTwin.stil.sprache,
        ton: safeTwin.stil.ton,
        format_pref: safeTwin.stil.format_pref,
        duzen: safeTwin.stil.duzen,
        max_woerter: safeTwin.stil.max_woerter_default,
      },
      veto: safeTwin.veto_regeln.map((v) => v.id),
      sensitive: safeTwin.sensitive_themen,
      exit: safeTwin.exit_ziel.beschreibung,
      projekte: safeTwin.projekte_aktiv.map((p) => {
        const out: { id: string; rolle: string; sensitivity?: "high" } = {
          id: p.id,
          rolle: p.rolle,
        };
        if (p.sensitivity === "high") out.sensitivity = "high";
        return out;
      }),
    };
    blocks.push(`<TWIN_USER>${JSON.stringify(payload)}</TWIN_USER>`);
  }

  if (domainTwin) {
    const payload: DomainTwinPayload = {
      workspace: domainTwin.workspaceLabel ?? domainTwin.workspaceId,
      type: domainTwin.workspaceType,
      sensitivity: domainTwin.sensitivity,
      accent: domainTwin.accent,
      active_workstreams: domainTwin.activeWorkstreams,
      recent_decisions: domainTwin.recentDecisions,
      open_tickets_p0_p1: domainTwin.openTicketsP0P1,
    };
    blocks.push(`<TWIN_DOMAIN>${JSON.stringify(payload)}</TWIN_DOMAIN>`);
  }

  return blocks.join("\n");
}
