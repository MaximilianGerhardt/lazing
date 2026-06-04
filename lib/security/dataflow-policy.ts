/**
 * Deterministic dataflow policy (wave 3a, 2026-05-03).
 *
 * Addresses the „symbolic AI" pillar: a cross-workspace dataflow decision
 * must go through a logic layer, NOT through LLM hope. Pure-logic
 * module without a database, without LLM, without IO. GDPR Art. 28 (tenant separation)
 * + Art. 30 (record-of-processing duty) are codified here, not inferred.
 *
 * Usage:
 *   - `lib/rag/retriever.ts#retrieveAcrossWorkspaces` calls `enforceDataflow`
 *     per requested workspace, writes an audit row when `auditSpec`.
 *   - `lib/rag/mcp-proxy.ts` analogously for MCP knowledge-base hits.
 *
 * Design principles:
 *   - No default-allow. Missing fields → reject.
 *   - System actor (`actorWsId === ''`) is a tightly bounded exception for
 *     migrations + cron jobs; high-sensitivity stays blocked.
 *   - Sub-agents inherit the actor WS from the parent — the caller MUST pass it through.
 *     This function only validates that the caller actually did.
 */

export type Sensitivity = 'low' | 'medium' | 'high';
export type ActorRole = 'user' | 'system' | 'sub-agent';

export interface DataflowRequest {
  /** The workspace in whose context the request arises. Empty string allowed only for system-actor. */
  actorWsId: string;
  /** The workspace whose data is to be read. Required. */
  requestedWsId: string;
  /** Classification of the requested data. At undefined → 'high' (fail-closed). */
  sensitivity?: Sensitivity;
  /** If true, ALWAYS write an audit row — even on same-ws. */
  auditRequired?: boolean;
  /** Who is asking? Default 'user'. */
  actorRole?: ActorRole;
  /** For sub-agent: the workspace passed through by the parent. Required if role='sub-agent'. */
  parentActorWsId?: string;
}

export interface DataflowAuditSpec {
  table: 'rag_cross_workspace_audit';
  row: {
    actorWsId: string;
    requestedWsId: string;
    sensitivity: Sensitivity;
    actorRole: ActorRole;
    reason: string;
  };
}

export interface DataflowDecision {
  allow: boolean;
  reason: string;
  auditSpec?: DataflowAuditSpec;
}

const DEFAULT_SENSITIVITY: Sensitivity = 'high';

function isNonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * Makes an allow/deny decision for a cross-workspace dataflow.
 * Pure function — no side effects.
 *
 * Rule order:
 *   1. requestedWsId required.
 *   2. Sensitivity default fail-closed (undefined → 'high').
 *   3. role='sub-agent' → inherits parentActorWsId, validates presence.
 *   4. role='system' AND actorWsId empty → allow without audit (except
 *      auditRequired=true AND sensitivity!='high'); high stays blocked.
 *   5. actor==requested → allow without audit (except auditRequired).
 *   6. actor!=requested AND high → deny.
 *   7. actor!=requested AND low|medium → allow WITH audit.
 */
export function enforceDataflow(req: DataflowRequest): DataflowDecision {
  // Step 1 — requestedWsId required.
  if (!isNonEmpty(req.requestedWsId)) {
    return { allow: false, reason: 'requestedWsId missing' };
  }

  // Step 2 — sensitivity default fail-closed.
  const sensitivity: Sensitivity = req.sensitivity ?? DEFAULT_SENSITIVITY;
  if (sensitivity !== 'low' && sensitivity !== 'medium' && sensitivity !== 'high') {
    return { allow: false, reason: `invalid sensitivity '${String(sensitivity)}'` };
  }

  const role: ActorRole = req.actorRole ?? 'user';

  // Step 3 — sub-agent inherits from the parent. Validation: parentActorWsId must be present
  // and the caller must have passed it through in actorWsId (or both match).
  let effectiveActorWsId = req.actorWsId;
  if (role === 'sub-agent') {
    if (!isNonEmpty(req.parentActorWsId)) {
      return {
        allow: false,
        reason: 'sub-agent: parentActorWsId required (inheritance rule)',
      };
    }
    // The caller passed parentActorWsId — that is the source of truth.
    // actorWsId may be empty (sub-agent has no own WS) or must match.
    if (isNonEmpty(req.actorWsId) && req.actorWsId !== req.parentActorWsId) {
      return {
        allow: false,
        reason: 'sub-agent: actorWsId mismatches parentActorWsId',
      };
    }
    effectiveActorWsId = req.parentActorWsId;
  }

  // Step 4 — system actor with empty actorWsId.
  if (role === 'system' && !isNonEmpty(req.actorWsId)) {
    if (sensitivity === 'high') {
      return {
        allow: false,
        reason: 'system-actor blocked on high-sensitivity workspace',
      };
    }
    if (req.auditRequired) {
      return {
        allow: true,
        reason: 'system-actor with audit-required override',
        auditSpec: {
          table: 'rag_cross_workspace_audit',
          row: {
            actorWsId: '',
            requestedWsId: req.requestedWsId,
            sensitivity,
            actorRole: 'system',
            reason: 'system-actor explicit audit',
          },
        },
      };
    }
    return { allow: true, reason: 'system-actor (migrations/cron)' };
  }

  // From here: regular user or sub-agent — the actor WS must be known.
  if (!isNonEmpty(effectiveActorWsId)) {
    return { allow: false, reason: 'actorWsId missing' };
  }

  // Step 5 — same workspace.
  if (effectiveActorWsId === req.requestedWsId) {
    if (req.auditRequired) {
      return {
        allow: true,
        reason: 'same-workspace (audit-required override)',
        auditSpec: {
          table: 'rag_cross_workspace_audit',
          row: {
            actorWsId: effectiveActorWsId,
            requestedWsId: req.requestedWsId,
            sensitivity,
            actorRole: role,
            reason: 'same-workspace explicit audit',
          },
        },
      };
    }
    return { allow: true, reason: 'same-workspace' };
  }

  // Step 6 — cross-workspace high → deny.
  if (sensitivity === 'high') {
    return {
      allow: false,
      reason: 'cross-workspace high-sensitivity denied (DSGVO Art. 28)',
    };
  }

  // Step 7 — cross-workspace low/medium → allow + audit.
  return {
    allow: true,
    reason: `cross-workspace ${sensitivity} (audit required)`,
    auditSpec: {
      table: 'rag_cross_workspace_audit',
      row: {
        actorWsId: effectiveActorWsId,
        requestedWsId: req.requestedWsId,
        sensitivity,
        actorRole: role,
        reason: `cross-workspace ${sensitivity}`,
      },
    },
  };
}
