// Spawns an iterate workstream (deep) in the lazyOS workspace with a roast
// assignment on 4 patterns from the Legaly-AI interview. Cards land in the
// chat automatically via emitOrUpdateCard. No HTTP, a direct service call.

import { createWorkstream } from '@/lib/workstreams/service';
import { runIterate } from '@/server/agents/tier-orchestrator';
import { TIER_PRESETS } from '@/lib/workstreams/tier-presets';
import { createTicket } from '@/lib/tickets/service';
import { defaultWorkspacePath } from '@/lib/workspaces/projects-root';

const WORKSPACE_ID = 'lazyos';
const WORKSPACE_PATH = process.env.LAZYOS_REPO_ROOT ?? defaultWorkspacePath(WORKSPACE_ID);

const PROMPT = `# Auftrag — Roast + Plan: 4 Legaly-AI-Patterns für lazyOS

## Quelle
YouTube-Interview mit Anne (Co-Founder Legaly AI, KI-Compliance-Plattform).
Volltext-Notiz: ~/knowledge-base/youtube/transcripts/2026-04-30_legaly-ai_anne_compliance_symbolic_ki.md
Mein Initial-Vorschlag (mit veralteten Code-Ankern): ~/knowledge-base/_patterns/hybrid-ai-symbolic-llm-for-lazyos.md
Vorab-Roast vom feature-orchestrator: docs/plans/2026-04-30_legaly-patterns-roast-and-plan.md

## Pflicht-Output (lazyOS-Style)
Pro Pattern eine **IST-Analyse** (was haben wir heute?), **Vorteile/Nachteile** (Token-Cost, UX, Maintenance), **SOLL** (was bauen?), **5-Perspektiven-Roast** (User Max, Hacker, Konkurrent Cline/Roo/Cursor, Performance, Maintenance), **Verdict** GO/KILL/MUTATE mit Begründung.

## Die 4 Patterns

### Pattern 1 — Symbolic Guards / Auto-Reprompt-Parser
- Idee: parsePlanQuestions schlägt fehl wenn <80% OPTIONS → tier-orchestrator startet sofort Re-Prompt-Stage (1 Loop-Versuch)
- Code-Anker: server/agents/tier-orchestrator.ts:943 (runIterate), :362 (runSynthesis), :2116 (runIterateResume), lib/workstreams/parse-plan-questions.ts
- Aufwand: ~30min

### Pattern 2 — Source-Attribution / Audit-Trail in Surface-Cards
- Idee: consensus-action + iterate-pipeline-Cards bekommen sources[]-Array (Files gelesen, Standards-RAG-Hits, Stage-Outputs). Kommt aus dem Code, NIE aus LLM-Output (Anti-Faking)
- Code-Anker: lib/chat/ConsensusActionCard.tsx, lib/chat/IteratePipelineCard.tsx, lib/chat/SurfaceRenderer.tsx, server/agents/tier-orchestrator.ts (emit-Punkte Z80/749/828/1592)
- Aufwand: ~2h

### Pattern 3 — Digital-Twin im Lead-Prompt
- Idee: Lead-System-Prompt bekommt Decision-Twin (letzte 1-3 Tickets+Verdicts), Code-Twin (git-State), Knowledge-Twin (RAG-Hits)
- Code-Anker: server/agent-server.ts, server/workspace-session.ts:1049 (existing Token-Verbot-Kommentar), server/agents/tier-orchestrator.ts (Lead-Prompts)
- Aufwand: ~1h
- ACHTUNG: STICKY-Memory sagt „MAX-Plan, keine Credits verbrennen". Token-Blowup ist ein Risiko.

### Pattern 4 — Behavioral-Bias-aware UI (4 Sub-Patterns)
- 4a Default-Bias Tier-Choice (Standard preselektiert) — ACHTUNG: laut Vorab-Roast bereits live in SurfaceRenderer.tsx:751. Bitte verifizieren.
- 4b Loss-Aversion Workspace-Delete (zeigt was verloren geht) — Discovery: existiert UI heute?
- 4c Sunk-Cost positiv: Sniper-V5 Progress-Pill in SniperInjectCard
- 4d Alarm-Fatigue: Push-Notifs Priority-Field, P0/P1 default, P2 digest
- Code-Anker: lib/chat/SurfaceRenderer.tsx, lib/chat/SniperInjectCard.tsx, lib/push/rules.ts (8 existing PUSH_RULES)

## Was eventuell FEHLT (aus Transkript ableitbar, aber vom feature-orchestrator schon vorgeschlagen)
- Pattern 5 — Hallucination-Score (baut auf P2 auf, Sprint 2)
- Pattern 7 — Innovation-Honesty-Score (Sprint 3)
- Compliance-as-Enabler-Idee von Anne: könnte für lazyOS bedeuten dass Sub-Plan-Qualität nicht „Bremse" ist sondern „Mehrmarkt-Enabler" (z.B. Multi-Repo-Spawning?)

## Constraints
- Anti-Pattern: KEINE Overlays erfinden, existing Surface-Library nutzen (STICKY-Memory)
- Anti-Pattern: KEINE Chat-Mirror ohne Loop-Guard (STICKY)
- MAX-Plan only — keine API-Credits verbrennen
- Worktree-basiert wenn parallele Branches
- Sprint-1 muss in <2h Wallclock parallel-startbar sein

## Output-Format
1. Konsolidierter Plan (3-7 Schritte)
2. User-Sicht (was klickt Max wann)
3. Risiken
4. Offene Fragen mit OPTIONS (≥80%)
5. Sub-Tickets als YAML-Block (V1 ist Tief-Modus, also V2 kommt — daher V1 OHNE Sub-Tickets, V2 mit)`;

async function main() {
  console.log('[1/3] Master-Plan-Ticket anlegen…');
  const ticket = await createTicket({
    workspaceId: WORKSPACE_ID,
    title: 'Roast + Plan: 4 Legaly-AI-Patterns für lazyOS',
    prio: 'P2',
    actor: 'system',
  });
  console.log('   Ticket:', ticket.id);

  console.log('[2/3] Workstream anlegen (Tief-Preset)…');
  const ws = await createWorkstream({
    workspaceId: WORKSPACE_ID,
    name: 'Legaly-Patterns Roast & Plan (Tief)',
    description: 'Iterate Tief mit 5-Perspektiven-Roast auf 4 Pattern-Vorschläge aus Legaly-AI-Interview',
    primaryTicketId: ticket.id,
    actor: 'system',
  });
  console.log('   Workstream:', ws.id);

  // Persist the deep config via Drizzle
  const { getDb } = await import('@/db/client');
  const { workstreams } = await import('@/db/schema/workstreams');
  const { eq } = await import('drizzle-orm');
  const db = getDb();
  const tiefConfig = TIER_PRESETS.tief;
  db.update(workstreams)
    .set({ mode: 'iterate', iterateConfigJson: JSON.stringify(tiefConfig) })
    .where(eq(workstreams.id, ws.id))
    .run();
  console.log('   Config: Tief (', tiefConfig.roasterCount, 'Roaster, sniperLoop=', tiefConfig.sniperLoop, ')');

  console.log('[3/3] runIterate läuft jetzt blocking — Skript bleibt offen bis Pipeline fertig.');
  console.log('       Workstream-ID:', ws.id);
  console.log('       PWA-URL: https://lazyos-seven.vercel.app/chat?ws=' + WORKSPACE_ID);
  console.log('       Erwartete Dauer (Tief): 5-10min Wallclock.\n');

  try {
    const res = await runIterate(
      {
        workspaceId: WORKSPACE_ID,
        workspacePath: WORKSPACE_PATH,
        parentTicketId: ticket.id,
        workstreamId: ws.id,
        originalPrompt: PROMPT,
      },
      tiefConfig,
    );
    console.log('\n=== DONE ===');
    console.log(JSON.stringify(res, null, 2).slice(0, 800));
  } catch (err) {
    console.error('\n=== FAIL ===');
    console.error((err as Error)?.stack ?? err);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
