/**
 * Pattern 2 Digital-Twin MVP — prompt formatter.
 *
 * Combines the owner twin (user) and domain twin (workspace) into two compact
 * JSON blocks with XML wrappers that the sub-agent can parse unambiguously:
 *
 *   <TWIN_USER>{...}</TWIN_USER>
 *   <TWIN_DOMAIN>{...}</TWIN_DOMAIN>
 *
 * Before (sub-agent read CLAUDE.md+MEMORY.md+standards): ~10K tokens.
 * After (validated JSON block): ≤500 tokens.
 *
 * Fail-soft: on a missing twin → empty string (the sub-spawn keeps running
 * undisturbed, it just gets no twin block).
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
 * Estimate: ~4 characters per token for mixed-content English+German.
 * Accurate enough for a soft-budget assertion in tests.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Combined twin block for system-prompt injection.
 * Returns an empty string when both twins are null.
 */
export async function formatTwinsForPrompt(
  workspaceId: string,
): Promise<string> {
  // Load in parallel — both are independent.
  const [ownerTwin, domainTwin] = await Promise.all([
    getOwnerTwin(),
    getDomainTwin(workspaceId),
  ]);

  const blocks: string[] = [];

  if (ownerTwin) {
    // Privacy Sprint V1 (2026-05-01): workspace-aware redaction.
    // In low-sensitivity workspaces (clients), private topics +
    // high-sensitivity projects are removed from the twin BEFORE they are sent to
    // the LLM cloud. High-sensitivity workspaces
    // (user's own trust zone) still get the full twin.
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
