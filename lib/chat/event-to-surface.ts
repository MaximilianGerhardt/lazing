/**
 * Event → surface-tag mapping
 *
 * Takes a LazyEvent (from /api/events/stream) and returns a surface-
 * tag string (`<surface:KIND>{json}</surface:KIND>`) that is rendered directly into a
 * system message in the chat.
 *
 * Null = the event is not chat-relevant (e.g. push_sent, internal noise).
 */

import type { LazyEventLike } from './useEventStream';

function ticketSurface(e: LazyEventLike, titleOverride?: string): string {
  const id = (e.entityId as string) ?? 'TCK-?';
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const title =
    titleOverride ??
    (typeof p.title === 'string' ? p.title : 'Neues Ticket');
  const prio =
    typeof p.priority === 'string'
      ? p.priority.toUpperCase()
      : typeof p.prio === 'string'
        ? p.prio
        : undefined;
  const body = typeof p.body === 'string' ? p.body : undefined;
  const assignee = typeof p.assignee === 'string' ? p.assignee : undefined;
  const due = typeof p.due === 'string' ? p.due : undefined;
  const segment =
    typeof p.workspaceId === 'string'
      ? p.workspaceId
      : typeof e.segmentId === 'string'
        ? e.segmentId
        : undefined;
  const obj: Record<string, unknown> = {
    id,
    status: typeof p.status === 'string' ? p.status : 'open',
    title,
  };
  if (prio) obj.prio = prio;
  if (body) obj.body = body;
  if (segment) obj.segment = segment;
  if (assignee) obj.assignee = assignee;
  if (due) obj.due = due;
  return `<surface:ticket>${JSON.stringify(obj)}</surface:ticket>`;
}

function toastSurface(
  variant: 'default' | 'ok' | 'warn' | 'err',
  title: string,
  body: string,
  iconGlyph = 'L',
): string {
  return `<surface:toast>${JSON.stringify({ variant, title, body, iconGlyph })}</surface:toast>`;
}

function approvalSurface(ticketId: string, title: string, sub?: string): string {
  const obj: Record<string, unknown> = { ticketId, title };
  if (sub) obj.sub = sub;
  return `<surface:approval>${JSON.stringify(obj)}</surface:approval>`;
}

// ---------------------------------------------------------------------------
// Wave 7 (2026-05-01) — loop-phase surfaces
// ---------------------------------------------------------------------------

type LoopPhaseKind =
  | 'auto-dispatch-stage'
  | 'auto-dispatch-stage-retry'
  | 'auto-dispatch-overview'
  | 'auto-dispatch-pause'
  | 'tier-output'
  | 'iterate-resumed'
  | 'sniper-pause-start';

function loopPhaseSurface(
  kind: LoopPhaseKind,
  payload: Record<string, unknown>,
  ev: LazyEventLike,
): string {
  const wsId =
    typeof payload.workstreamId === 'string'
      ? payload.workstreamId
      : typeof ev.entityId === 'string'
        ? ev.entityId
        : '';
  const workspaceId =
    typeof payload.workspaceId === 'string'
      ? payload.workspaceId
      : typeof ev.segmentId === 'string'
        ? ev.segmentId
        : '';
  const obj: Record<string, unknown> = {
    kind,
    workstreamId: wsId,
    workspaceId,
  };
  // Consolidate stage/tier/roaster/Vn-specific fields.
  if (typeof payload.stage === 'string') obj.stage = payload.stage;
  if (typeof payload.tier === 'string') obj.tier = payload.tier;
  if (typeof payload.agentIdx === 'number') obj.agentIdx = payload.agentIdx;
  if (typeof payload.stageIdx === 'number') obj.stageIdx = payload.stageIdx;
  if (typeof payload.attempt === 'number') obj.attempt = payload.attempt;
  if (typeof payload.maxAttempts === 'number')
    obj.maxAttempts = payload.maxAttempts;
  if (typeof payload.waitMs === 'number') obj.waitMs = payload.waitMs;
  if (typeof payload.versionN === 'number') obj.versionN = payload.versionN;
  if (typeof payload.text === 'string')
    obj.text = payload.text.length > 280 ? payload.text.slice(0, 280) + '…' : payload.text;
  if (typeof payload.reason === 'string') obj.reason = payload.reason;
  if (typeof payload.actor === 'string') obj.actor = payload.actor;
  else if (typeof ev.actor === 'string') obj.actor = ev.actor.replace(/^agent:/, '');
  return `<surface:loop-phase>${JSON.stringify(obj)}</surface:loop-phase>`;
}

function iterateRoastSurface(payload: Record<string, unknown>, ev: LazyEventLike): string {
  const obj: Record<string, unknown> = {
    workstreamId:
      typeof payload.workstreamId === 'string'
        ? payload.workstreamId
        : typeof ev.entityId === 'string'
          ? ev.entityId
          : '',
    workspaceId:
      typeof payload.workspaceId === 'string'
        ? payload.workspaceId
        : typeof ev.segmentId === 'string'
          ? ev.segmentId
          : '',
  };
  if (typeof payload.roasterIdx === 'number') obj.roasterIdx = payload.roasterIdx;
  if (typeof payload.role === 'string') obj.role = payload.role;
  if (typeof payload.versionN === 'number') obj.versionN = payload.versionN;
  if (typeof payload.text === 'string')
    obj.text = payload.text.length > 480 ? payload.text.slice(0, 480) + '…' : payload.text;
  if (typeof payload.summary === 'string') obj.summary = payload.summary;
  return `<surface:iterate-roast>${JSON.stringify(obj)}</surface:iterate-roast>`;
}

function iterateVersionSurface(payload: Record<string, unknown>, ev: LazyEventLike): string {
  const obj: Record<string, unknown> = {
    workstreamId:
      typeof payload.workstreamId === 'string'
        ? payload.workstreamId
        : typeof ev.entityId === 'string'
          ? ev.entityId
          : '',
    workspaceId:
      typeof payload.workspaceId === 'string'
        ? payload.workspaceId
        : typeof ev.segmentId === 'string'
          ? ev.segmentId
          : '',
  };
  if (typeof payload.versionN === 'number') obj.versionN = payload.versionN;
  if (typeof payload.text === 'string') {
    const t = payload.text;
    obj.text = t.length > 600 ? t.slice(0, 600) + '…' : t;
  }
  if (typeof payload.headline === 'string') obj.headline = payload.headline;
  if (typeof payload.costCents === 'number') obj.costCents = payload.costCents;
  return `<surface:iterate-version>${JSON.stringify(obj)}</surface:iterate-version>`;
}

function userCorrectionSurface(payload: Record<string, unknown>, ev: LazyEventLike): string {
  const obj: Record<string, unknown> = {
    workstreamId:
      typeof payload.workstreamId === 'string'
        ? payload.workstreamId
        : typeof ev.entityId === 'string'
          ? ev.entityId
          : '',
  };
  if (typeof payload.message === 'string') {
    const m = payload.message;
    obj.message = m.length > 240 ? m.slice(0, 240) + '…' : m;
  }
  if (typeof payload.injectedAt === 'string') obj.injectedAt = payload.injectedAt;
  if (typeof payload.versionN === 'number') obj.versionN = payload.versionN;
  return `<surface:user-correction>${JSON.stringify(obj)}</surface:user-correction>`;
}

function planOpenQuestionsCardSurface(
  payload: Record<string, unknown>,
  ev: LazyEventLike,
): string {
  const obj: Record<string, unknown> = {
    workstreamId:
      typeof payload.workstreamId === 'string'
        ? payload.workstreamId
        : typeof ev.entityId === 'string'
          ? ev.entityId
          : '',
    workspaceId:
      typeof payload.workspaceId === 'string'
        ? payload.workspaceId
        : typeof ev.segmentId === 'string'
          ? ev.segmentId
          : '',
  };
  const rawQs = Array.isArray(payload.questions) ? payload.questions : [];
  const questions = rawQs
    .map((q) => {
      if (!q || typeof q !== 'object') return null;
      const o = q as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : '';
      const text = typeof o.q === 'string' ? o.q : typeof o.question === 'string' ? o.question : '';
      if (!id || !text) return null;
      const opts = Array.isArray(o.options)
        ? o.options.filter((x): x is string => typeof x === 'string').slice(0, 5)
        : undefined;
      return opts && opts.length > 0 ? { id, q: text, options: opts } : { id, q: text };
    })
    .filter((x): x is { id: string; q: string; options?: string[] } => x !== null)
    .slice(0, 6);
  if (questions.length === 0) return '';
  obj.questions = questions;
  return `<surface:plan-open-questions>${JSON.stringify(obj)}</surface:plan-open-questions>`;
}

export interface EventSurfaceMapResult {
  /** Markdown-like text with embedded <surface:*> tag. */
  text: string;
  /** Severity → affects UI styling of the system-message. */
  severity: 'info' | 'warn' | 'critical';
  /** Deep-link target if applicable (e.g. `/tickets/TCK-123`). */
  href?: string;
}

export function eventToSurface(
  ev: LazyEventLike,
): EventSurfaceMapResult | null {
  const type = ev.type ?? '';
  const entityType = ev.entityType ?? '';
  const entityId = ev.entityId ?? '';
  const payload = ev.payload ?? {};

  // --- updated with transition='auto_dispatch' (Phase AD · 2026-04-26) ---
  // Sub-Plan 05 polish (2026-04-29): per-sub-ticket toast suppressed.
  // With 6 subs these are 6 near-identical cards in the stream. The
  // LivePipeline card shows all subs in a single overview.
  if (type === 'updated' && entityType === 'ticket') {
    const transition = typeof payload.transition === 'string' ? payload.transition : '';
    if (transition === 'auto_dispatch') {
      return null;
    }
    if (transition === 'auto_close_after_subs') {
      const total =
        typeof payload.subTicketsTotal === 'number'
          ? payload.subTicketsTotal
          : 0;
      const milestonePayload: Record<string, unknown> = {
        headline: `Master geschlossen · ${entityId}`,
        sub:
          total > 0
            ? `Alle ${total} Sub-Tickets erledigt`
            : 'Alle Sub-Tickets erledigt',
        bullets: ['Auto-Close nach erfolgreicher Pipeline'],
        costSaved: 'MAX-Plan',
        quality: 4.5,
      };
      if (entityId) milestonePayload.href = `/tickets/${entityId}`;
      return {
        text: `<surface:milestone>${JSON.stringify(milestonePayload)}</surface:milestone>`,
        severity: 'info',
        href: entityId ? `/tickets/${entityId}` : undefined,
      };
    }
    if (transition === 'auto_dispatch_failed') {
      const stage =
        typeof payload.failedStage === 'string' ? payload.failedStage : 'unknown';
      const reason =
        typeof payload.error === 'string' ? payload.error : 'fehlgeschlagen';
      return {
        text: toastSurface(
          'err',
          `Auto-Dispatch fehlgeschlagen · ${entityId}`,
          `Stage ${stage}: ${reason}`,
          // Severity is carried by the 'err' toast variant (colour + a11y role).
          '!',
        ),
        severity: 'critical',
        href: entityId ? `/tickets/${entityId}` : undefined,
      };
    }
    if (transition === 'pipeline_complete') {
      // Sub-Plan 05 polish (2026-04-29): per-sub toast suppressed.
      // The LivePipeline card marks the sub row as finished
      // once all 3 stages have run. A per-sub toast would be
      // duplicate info in the stream.
      return null;
    }
  }

  // --- commented kind=auto-dispatch-stage-retry (Phase 2026-04-26) ---
  // Sub-Plan 05 polish (2026-04-29): no more stream toasts.
  // The LivePipeline card visualizes retry states in the stage
  // column. Otherwise 3 subs × retry × N = chaotic spam.
  if (
    type === 'commented' &&
    (payload as Record<string, unknown>).kind === 'auto-dispatch-stage-retry'
  ) {
    return null;
  }

  // --- commented kind=iterate-error (Phase IT · 2026-04-27) ---
  // Lead-V1 or roast or V2 failed — the user should see this immediately
  // instead of waiting for nothing for minutes.
  if (
    type === 'commented' &&
    (payload as Record<string, unknown>).kind === 'iterate-error'
  ) {
    const p = payload as Record<string, unknown>;
    const stage = typeof p.stage === 'string' ? p.stage : 'iterate';
    const errMsg = typeof p.error === 'string' ? p.error : 'unbekannt';
    return {
      text: toastSurface(
        'err',
        'Iterate fehlgeschlagen · ' + stage,
        errMsg.slice(0, 120),
        '!',
      ),
      severity: 'critical',
      href: entityId ? `/tickets/${entityId}` : undefined,
    };
  }

  // --- commented kind=auto-dispatch-overview (Phase WSC.1 · 2026-04-26) ---
  // Auto-dispatch has started — emit a live-pipeline card.
  // The card subscribes itself to further stage events. Idempotently
  // deduped via the event.id in the chat render.
  if (
    type === 'commented' &&
    (payload as Record<string, unknown>).kind === 'auto-dispatch-overview'
  ) {
    const p = payload as Record<string, unknown>;
    const wsId = typeof p.workstreamId === 'string' ? p.workstreamId : '';
    const masterTicketId =
      typeof p.masterTicketId === 'string' ? p.masterTicketId : entityId ?? '';
    const subTicketsRaw = Array.isArray(p.subTickets) ? p.subTickets : [];
    if (!wsId || !masterTicketId || subTicketsRaw.length === 0) {
      return null;
    }
    const subTickets = subTicketsRaw
      .map((s) => {
        if (!s || typeof s !== 'object') return null;
        const o = s as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        const title = typeof o.title === 'string' ? o.title : id;
        if (!id) return null;
        return { id, title };
      })
      .filter((x): x is { id: string; title: string } => x !== null);
    if (subTickets.length === 0) return null;
    const livePayload = {
      workstreamId: wsId,
      workspaceId: ev.segmentId ?? '',
      masterTicketId,
      subTickets,
      href: `/tickets/${encodeURIComponent(masterTicketId)}`,
    };
    return {
      text: `<surface:live-pipeline>${JSON.stringify(livePayload)}</surface:live-pipeline>`,
      severity: 'info',
      href: `/tickets/${encodeURIComponent(masterTicketId)}`,
    };
  }

  // --- commented kind=auto-dispatch-stage (Phase AD · 2026-04-26) ---
  // Sub-Plan 05 polish (2026-04-29): no more stream toasts.
  // 6 subs × 3 stages = 18 toasts overwhelm the chat. The existing
  // LivePipeline card subscribes itself to these events and fills the
  // 3-column table (senior-dev → reviewer → critic). A double
  // visualization in the stream + in the card was spam.
  if (
    type === 'commented' &&
    (payload as Record<string, unknown>).kind === 'auto-dispatch-stage'
  ) {
    return null;
  }

  // --- bug_fix_pipeline_phase (Wave 2 · 2026-05-03) ---
  // A live card for the 8-phase bug-fix pipeline. Instead of 8 separate toasts
  // we emit 1 surface card with a phase stepper. The card subscribes itself
  // to further bug_fix_pipeline_phase events from the same workstreamId and
  // fills the stepper progressively.
  if (type === 'bug_fix_pipeline_phase') {
    const p = payload as Record<string, unknown>;
    const wsId = typeof p.workstreamId === 'string' ? p.workstreamId : '';
    const workspaceId =
      typeof p.workspaceId === 'string'
        ? p.workspaceId
        : typeof ev.segmentId === 'string'
        ? ev.segmentId
        : '';
    if (!wsId) return null;
    const obj: Record<string, unknown> = {
      workstreamId: wsId,
      workspaceId,
    };
    if (typeof p.phase === 'string') obj.phase = p.phase;
    if (typeof p.phaseIdx === 'number') obj.phaseIdx = p.phaseIdx;
    if (typeof p.hypothesisCount === 'number') obj.hypothesisCount = p.hypothesisCount;
    if (typeof p.planCount === 'number') obj.planCount = p.planCount;
    if (typeof p.criticCount === 'number') obj.criticCount = p.criticCount;
    if (typeof p.summary === 'string') {
      const s = p.summary;
      obj.summary = s.length > 240 ? s.slice(0, 240) + '…' : s;
    }
    if (typeof p.status === 'string') obj.status = p.status;
    if (typeof p.masterTicketId === 'string') obj.masterTicketId = p.masterTicketId;
    if (typeof p.bugDescription === 'string') {
      const b = p.bugDescription;
      obj.bugDescription = b.length > 240 ? b.slice(0, 240) + '…' : b;
    }
    return {
      text: `<surface:bug-fix-pipeline>${JSON.stringify(obj)}</surface:bug-fix-pipeline>`,
      severity: 'info',
      href: wsId ? `/workstreams/${wsId}` : undefined,
    };
  }

  // --- approval_requested ---
  if (type === 'approval_requested') {
    const title =
      typeof payload.title === 'string'
        ? payload.title
        : `Freigabe für ${entityId}`;
    return {
      text: approvalSurface(entityId, title),
      severity: 'critical',
      href: entityId ? `/tickets/${entityId}` : undefined,
    };
  }

  // --- decision_request ---
  if (type === 'decision_request' || entityType === 'decision_request') {
    const q = typeof payload.question === 'string' ? payload.question : '';
    const options = Array.isArray(payload.options)
      ? payload.options
      : [];
    const decisionPayload: Record<string, unknown> = {
      headline: q || 'Entscheidung nötig',
      sub: typeof payload.context === 'string' ? payload.context : undefined,
      options:
        options.length > 0
          ? options
          : [
              { id: 'yes', label: 'Ja', recommended: true },
              { id: 'no', label: 'Nein' },
            ],
    };
    return {
      text: `<surface:decision>${JSON.stringify(decisionPayload)}</surface:decision>`,
      severity: 'warn',
    };
  }

  // --- ticket_created (P0 = critical) ---
  if (type === 'ticket_created' || (type === 'created' && entityType === 'ticket')) {
    const p = payload as {
      priority?: string;
      prio?: string;
      title?: string;
      parentTicketId?: string;
    };
    // Sub-Plan 05 (2026-04-29) — filter sub-tickets out of the stream.
    // When parentTicketId is set, the ticket was created as a sub via the
    // finalize pipeline and is already visible in the ConsensusActionCard's
    // collapsible sub-tickets section. No additional stream spam.
    if (p.parentTicketId) {
      return null;
    }
    const prio = (p.priority ?? p.prio ?? '').toString().toUpperCase();
    if (prio === 'P0') {
      return {
        text: `**P0 Ticket angelegt** · ${p.title ?? entityId}\n${ticketSurface(ev)}`,
        severity: 'critical',
        href: entityId ? `/tickets/${entityId}` : undefined,
      };
    }
    // P1/P2 as a quiet toast — not as prominent as P0
    return {
      text: `${ticketSurface(ev)}`,
      severity: 'info',
      href: entityId ? `/tickets/${entityId}` : undefined,
    };
  }

  // --- workspace_heartbeat stale/dormant ---
  if (type === 'workspace_heartbeat') {
    const status = typeof payload.status === 'string' ? payload.status : '';
    const lagSec =
      typeof payload.lag_sec === 'number' ? payload.lag_sec : null;
    if (status === 'stale' || status === 'dormant') {
      const ws =
        typeof payload.workspaceId === 'string'
          ? payload.workspaceId
          : entityId;
      const hours = lagSec !== null ? Math.round(lagSec / 3600) : null;
      return {
        text: toastSurface(
          'warn',
          `Workspace ${ws} ${status}`,
          hours !== null
            ? `seit ${hours}h keine Aktivität`
            : 'keine Aktivität',
          // Severity is carried by the 'warn' toast variant (colour + a11y role).
          '!',
        ),
        severity: 'warn',
      };
    }
    return null; // alive/error → do not spam in the chat
  }

  // --- routine_run failure ---
  if (type === 'routine_run') {
    const status = typeof payload.status === 'string' ? payload.status : '';
    if (status === 'failure' || status === 'error') {
      const name =
        typeof payload.routineName === 'string'
          ? payload.routineName
          : typeof payload.name === 'string'
            ? payload.name
            : (entityId || 'Routine');
      const reason =
        typeof payload.error === 'string'
          ? payload.error
          : typeof payload.reason === 'string'
            ? payload.reason
            : 'Fehler beim Ausführen';
      return {
        text: toastSurface('err', `Routine fehlgeschlagen: ${name}`, reason, '!'),
        severity: 'warn',
      };
    }
    return null;
  }

  // --- error_logged bursts: 5 within 5 min → toast err ---
  // (Burst detection is a server job; the event comes with `payload.burst=true`.)
  if (type === 'error_logged' && payload.burst === true) {
    const count =
      typeof payload.count === 'number' ? payload.count : 5;
    return {
      text: toastSurface(
        'err',
        `${count} Fehler in 5 Min`,
        'Check /observatory für Details',
        '!',
      ),
      severity: 'critical',
      href: '/observatory',
    };
  }

  // --- commented kind=git-commit (Phase TB: Terminal-Claude commit-bridge) ---
  // An agent (typically actor=agent:terminal-claude) committed in the
  // lazyos repo. A subtle toast in the chat so Max has passive
  // visibility without having to open a terminal.
  //
  // Sub-Plan B (2026-04-30): if the commit subject contains `[skip-mirror]`,
  // do NOT surface in the chat. Auto-dispatch sub-agents
  // commit with this footer to avoid echo loops + chat spam.
  if (
    type === 'commented' &&
    (payload as Record<string, unknown>).kind === 'git-commit'
  ) {
    const shaRaw =
      typeof payload.commitSha === 'string' ? (payload.commitSha as string) : '';
    const sha = shaRaw.slice(0, 7) || '???????';
    const subjectRaw =
      typeof payload.messageSubject === 'string'
        ? (payload.messageSubject as string)
        : '';
    if (subjectRaw.includes('[skip-mirror]')) {
      // Skip — sub-agent commit, no chat toast, no echo.
      return null;
    }
    const subject =
      subjectRaw.length > 0 ? subjectRaw.slice(0, 100) : '(no subject)';
    const filesChanged =
      typeof payload.filesChanged === 'number'
        ? (payload.filesChanged as number)
        : null;
    const repo =
      typeof payload.repo === 'string' ? (payload.repo as string) : 'lazyos';
    const subParts: string[] = [];
    if (filesChanged !== null) {
      subParts.push(`${filesChanged} file${filesChanged === 1 ? '' : 's'}`);
    }
    subParts.push(repo);
    return {
      text: toastSurface(
        'default',
        `Commit ${sha}: ${subject}`,
        subParts.join(' · '),
        // Default brand glyph — commit context is already in the title.
      ),
      severity: 'info',
    };
  }

  // --- commented kind=synthesis (workstream-lead synthesizer done) ---
  // PHASE I (user wish 2026-04-26): synthesis comes back into the chat
  // as a prominent milestone card instead of a system toast.
  if (type === 'commented' && (payload as Record<string, unknown>).kind === 'synthesis') {
    const synthText = typeof payload.text === 'string' ? payload.text : '';
    const wsId =
      typeof payload.workstreamId === 'string' ? payload.workstreamId : '';
    const cost =
      typeof payload.costCents === 'number' ? payload.costCents : 0;
    const nInputs =
      typeof payload.n_inputs === 'number' ? payload.n_inputs : 0;
    // First headline (## ...) as the headline
    const firstHeadline =
      synthText
        .split('\n')
        .find((l) => /^##\s/.test(l))
        ?.replace(/^##\s+/, '')
        .slice(0, 60) ?? 'Plan-Synthese fertig';
    // First 3 bullet points (- foo) as bullets
    const bullets = synthText
      .split('\n')
      .filter((l) => /^[-*]\s+\S/.test(l))
      .slice(0, 3)
      .map((l) => l.replace(/^[-*]\s+/, '').slice(0, 80));
    // P11 (2026-05-01): if writeReasoningAudit() returned an
    // ID for this synthesis, the caller attaches it as payload.reasoningAuditId.
    // The mapper forwards it as auditId to the MilestoneCard, which then
    // renders a SourceChipRow in the footer.
    const auditIdRaw = (payload as Record<string, unknown>).reasoningAuditId;
    const auditId = typeof auditIdRaw === 'string' ? auditIdRaw : undefined;
    // Apple-UX (2026-05-30): plan synthesis is an INFO, not a triumph.
    // `variant: 'quiet'` renders a quiet info line instead of the big
    // keynote card — it must NEVER be louder than a blocking gate.
    // The info is fully preserved (headline/sub/bullets/href).
    const milestonePayload: Record<string, unknown> = {
      variant: 'quiet',
      headline: firstHeadline,
      sub: `Konsolidiert aus ${nInputs} Sub-Agent-Outputs`,
      bullets: bullets.length > 0 ? bullets : ['Plan-Doc bereit', 'User-Sicht', 'Offene Fragen'],
      costSaved: cost > 0 ? `MAX-Plan, gespart ≈ €${(cost / 100).toFixed(2)}` : 'MAX-Plan',
      quality: 4.2,
      href: wsId ? `/workstreams/${wsId}` : entityId ? `/tickets/${entityId}` : undefined,
    };
    if (auditId) milestonePayload.auditId = auditId;
    return {
      text: `<surface:milestone>${JSON.stringify(milestonePayload)}</surface:milestone>`,
      severity: 'info',
      href: wsId ? `/workstreams/${wsId}` : undefined,
    };
  }

  // --- commented from a tier-spawn agent (workstream activity) ---
  // Subtle as a toast — the user should see live activity but not be flooded.
  if (type === 'commented' && typeof ev.actor === 'string' && /^agent:(opus|sonnet|haiku)-/.test(ev.actor)) {
    const role = ev.actor.replace(/^agent:/, '');
    return {
      text: toastSurface(
        'default',
        `${role} liefert ab`,
        `Comment am Master-Ticket`,
        '·',
      ),
      severity: 'info',
      href: entityId ? `/tickets/${entityId}` : undefined,
    };
  }

  // --- commented with @max mention ---
  if (type === 'commented') {
    const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
    const includesMax = mentions.some(
      (m) =>
        typeof m === 'string' &&
        (m === '@max' || m === '@chairman' || m.endsWith('user:max')),
    );
    if (includesMax) {
      const actor =
        typeof ev.actor === 'string' ? ev.actor.replace(/^agent:/, '') : 'Agent';
      const body =
        typeof payload.body === 'string' ? payload.body.slice(0, 140) : '';
      return {
        text: toastSurface(
          'default',
          `${actor} hat dich erwähnt`,
          `${body}${body.length === 140 ? '…' : ''}`,
          '@',
        ),
        severity: 'warn',
        href: entityId ? `/tickets/${entityId}` : undefined,
      };
    }
    return null; // do not spam normal comments
  }

  // Everything else: no chat-relevant surface
  return null;
}
