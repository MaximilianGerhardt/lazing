/**
 * /lab/[kind] Detail-Page (MVP, 2026-05-01).
 *
 * 6 Tabs: Live | Refactored | Real-Use | Diff | Tokens | Spring-Compare
 * Tab-State via ?tab=. Default: 'real' (echte Daten zeigen, nicht
 * synthetisches Beispiel).
 *
 * MVP-Mode:
 *   - Live: synthetischer Sample-Payload als JSON-Pretty (Welle 3 mountet
 *     <SurfaceRenderer> mit echtem Card-Component)
 *   - Refactored: Placeholder „Verfügbar nach Welle 3-Refactor"
 *   - Real-Use: lädt Top-N echte Events aus der DB (redacted)
 *   - Diff: grep-Output von borderRadius/fontSize-Hits aus Card-File
 *   - Tokens: liest verwendete CSS-Custom-Properties aus Card-File
 *   - Spring-Compare: Side-by-Side pure-CSS vs motion/react Mount-Spring
 *     (Welle 8, Decision-Feature für Production-Stack)
 *
 * Auth ist im Layout abgehandelt.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { notFound } from "next/navigation";

import { ConsensusActionCard } from "../../../lib/chat/ConsensusActionCard";
import { IteratePipelineCard } from "../../../lib/chat/IteratePipelineCard";
import { LivePipeline } from "../../../lib/chat/LivePipeline";
import { MilestoneCard } from "../../../lib/chat/MilestoneCard";
import { SubWorkstreamsCard } from "../../../lib/chat/SubWorkstreamsCard";
import { LiveSurfacePanel } from "../_components/LiveSurfacePanel";
import { RealDataLoader } from "../_components/RealDataLoader";
import { SpringStackToggle } from "../_components/SpringStackToggle";
import { StreamingBubbleMockShow } from "../_components/StreamingBubbleMockShow";
import {
  isLabTabId,
  SurfaceShowcase,
  type LabTabId,
} from "../_components/SurfaceShowcase";
import { findKindById } from "../_lib/kinds-catalog";

export const dynamic = "force-dynamic";

interface DetailPageProps {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ tab?: string; workspace?: string }>;
}

function samplePayloadFor(kind: string): Record<string, unknown> {
  // Welle 7 (2026-05-01): Mocks gegen echtes Surface-Tag-Schema gebaut, damit
  // der Live-Tab via renderSurface() echte Cards rendert.
  switch (kind) {
    case "auto-dispatch-stage":
      return {
        kind: "auto-dispatch-stage",
        workstreamId: "01J0LAB000000000000000WS01",
        workspaceId: "demo-fitness",
        stage: "senior-dev",
        stageIdx: 0,
        actor: "agent:opus-senior-dev",
        text: "Edge-Cases in OnboardingForm: Loading-State + leerer User-Profile-Branch sind jetzt abgedeckt.",
      };
    case "iterate-roast":
      return {
        workstreamId: "01J0LAB000000000000000WS01",
        workspaceId: "demo-fitness",
        roasterIdx: 2,
        role: "iterate-roaster-2",
        versionN: 2,
        text: "Performance-Sicht: der Re-Render bei jedem Tick ist okay, aber memo() auf den Status-Pill wäre billig und entfernt 60% der Renders.",
      };
    case "iterate-version":
      return {
        workstreamId: "01J0LAB000000000000000WS01",
        workspaceId: "demo-fitness",
        versionN: 3,
        text: "## V3 — Inline-Memo + Disabled-State\n\n- memo() um die StatusPill\n- disabled-Flag bei retry-pending\n- aria-busy auf dem Container",
        costCents: 18,
      };
    case "sniper-pause-start":
      return {
        kind: "sniper-pause-start",
        workstreamId: "01J0LAB000000000000000WS01",
        workspaceId: "demo-fitness",
        versionN: 2,
        waitMs: 25_000,
        actor: "system",
        text: "Pause vor V3 — letzte Chance zum User-Inject (25s).",
      };
    case "plan-open-questions":
      return {
        workstreamId: "01J0LAB000000000000000WS01",
        workspaceId: "lazyos",
        questions: [
          {
            id: "q-1",
            q: "Soll der Onboarding-Schritt optional sein oder Pflicht?",
            options: ["Optional", "Pflicht (Default)", "Pflicht (mit Skip-Link)"],
          },
          {
            id: "q-2",
            q: "Wie viele Roaster-Perspektiven für die V2-Phase?",
            options: ["2", "3", "5"],
          },
        ],
      };
    case "sub-workstream":
      return {
        kind,
        parentTicket: "ws-demo-pv-pipeline",
        subTickets: [
          { id: "sub-1", label: "Dachvermessung", status: "open" },
          { id: "sub-2", label: "Statik-Prüfung", status: "in-progress" },
        ],
      };
    case "bug-fix-swarm":
      return {
        kind,
        spawns: 3,
        diagnoses: [
          { agent: "diag-a", hypothesis: "Race-Condition in subscription" },
          { agent: "diag-b", hypothesis: "Stale-Cache nach Hot-Reload" },
          { agent: "diag-c", hypothesis: "Migration 0048 nicht idempotent" },
        ],
      };
    case "synthesis":
      return {
        kind,
        consolidated:
          "3 Reviewer-Stimmen → Blocker an OnboardingForm.tsx#L142, Fix-Vorschlag liegt vor",
        confidence: "high",
      };
    default:
      return { kind, note: "Kein Sample für diesen Kind hinterlegt" };
  }
}

/**
 * Welle 7 (2026-05-01): Mappt Kind-IDs auf den `surface:KIND`-Tag-Namen.
 * Manche Kinds (auto-dispatch-stage, sniper-pause-start) werden via die
 * generische LoopPhaseCard gerendert und brauchen den `loop-phase`-Tag.
 */
function surfaceKindFor(kindId: string): string | null {
  if (kindId === "auto-dispatch-stage" || kindId === "sniper-pause-start") {
    return "loop-phase";
  }
  if (
    kindId === "iterate-roast" ||
    kindId === "iterate-version" ||
    kindId === "plan-open-questions"
  ) {
    return kindId;
  }
  // Andere Kinds (sub-workstream, bug-fix-swarm, synthesis) werden weiterhin
  // als JSON-Pretty gerendert — sie haben jeweils eigene Cards mit anderen
  // payload-Shapes die nicht 1:1 vom Mock passen.
  return null;
}

function readCardFileSafe(componentPath: string): string | null {
  const abs = path.join(process.cwd(), componentPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

interface DiffHit {
  pattern: string;
  matches: number;
  examples: string[];
}

function findDiffHits(content: string): DiffHit[] {
  const PATTERNS: Array<{ name: string; re: RegExp }> = [
    { name: "borderRadius (hardcoded)", re: /borderRadius:\s*['"]?\d/g },
    { name: "fontSize (hardcoded)", re: /fontSize:\s*\d/g },
    { name: "color (hardcoded hex)", re: /color:\s*['"]#[0-9A-Fa-f]/g },
    { name: "padding (hardcoded)", re: /padding:\s*['"]?\d/g },
  ];
  return PATTERNS.map(({ name, re }) => {
    const matches = content.match(re) ?? [];
    return {
      pattern: name,
      matches: matches.length,
      examples: matches.slice(0, 3),
    };
  });
}

function findUsedTokens(content: string): string[] {
  const re = /var\(--[a-zA-Z0-9_-]+\)/g;
  const set = new Set<string>();
  for (const m of content.match(re) ?? []) set.add(m);
  return Array.from(set).sort();
}

export default async function LabKindPage({
  params,
  searchParams,
}: DetailPageProps): Promise<React.JSX.Element> {
  const { kind } = await params;
  const sp = await searchParams;

  const meta = findKindById(kind);
  if (!meta) notFound();

  const activeTab: LabTabId = isLabTabId(sp.tab) ? sp.tab : "real";

  const cardSource = readCardFileSafe(meta.componentPath);
  const diffHits = cardSource ? findDiffHits(cardSource) : [];
  const usedTokens = cardSource ? findUsedTokens(cardSource) : [];
  const samplePayload = samplePayloadFor(meta.id);

  const surfaceKind = surfaceKindFor(meta.id);
  const jsonFallback = (
    <CodeBlock
      title="Sample-Payload (Card-Mock, kein direktes Surface-Tag-Mapping)"
      content={JSON.stringify(samplePayload, null, 2)}
    />
  );
  const livePanel = (
    <LiveSurfacePanel
      surfaceKind={surfaceKind as
        | import("../../../lib/chat/surface-parser").SurfaceKind
        | null}
      payload={samplePayload}
      jsonFallbackTitle={`Sample für ${meta.label}`}
      jsonFallback={jsonFallback}
    />
  );

  const refactoredPanel = (
    <RefactoredPanel kindId={meta.id} />
  );

  const realPanel = (
    <RealDataLoader kind={meta.id} workspaceId={sp.workspace} limit={5} />
  );

  const diffPanel = cardSource ? (
    <DiffPanel componentPath={meta.componentPath} hits={diffHits} />
  ) : (
    <PlaceholderPanel
      title="Card-File nicht gefunden"
      body={`Pfad: ${meta.componentPath} (relativ zum Repo-Root)`}
    />
  );

  const tokensPanel = cardSource ? (
    <TokensPanel componentPath={meta.componentPath} tokens={usedTokens} />
  ) : (
    <PlaceholderPanel
      title="Card-File nicht gefunden"
      body={`Pfad: ${meta.componentPath} (relativ zum Repo-Root)`}
    />
  );

  const springPanel = (
    <SpringStackToggle cardChildren={<RefactoredSample kindId={meta.id} />} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--fg-muted, #999)",
          }}
        >
          {meta.archetype}
        </span>
        <h1
          style={{
            fontSize: 32,
            fontWeight: 600,
            margin: 0,
            letterSpacing: "-0.02em",
            color: "var(--fg, #fff)",
          }}
        >
          {meta.label}
        </h1>
        <p
          style={{
            fontSize: 14,
            color: "var(--fg-muted, #B0B0B0)",
            margin: 0,
            maxWidth: 720,
            lineHeight: 1.5,
          }}
        >
          {meta.description} · Primary Workspace:{" "}
          <code style={{ color: "var(--fg, #fff)" }}>{meta.primaryWorkspace}</code> ·
          Component:{" "}
          <code style={{ color: "var(--fg, #fff)" }}>{meta.componentPath}</code>
        </p>
      </header>

      <SurfaceShowcase
        activeTab={activeTab}
        panels={{
          live: livePanel,
          refactored: refactoredPanel,
          real: realPanel,
          diff: diffPanel,
          tokens: tokensPanel,
          spring: springPanel,
        }}
      />
    </div>
  );
}

function CodeBlock({
  title,
  content,
}: {
  title: string;
  content: string;
}): React.JSX.Element {
  return (
    <section
      style={{
        background: "var(--sheet-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        padding: 20,
      }}
    >
      <h3
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--fg-muted, #999)",
          margin: 0,
          marginBottom: 12,
        }}
      >
        {title}
      </h3>
      <pre
        style={{
          margin: 0,
          padding: 16,
          background: "var(--sheet-3)",
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
          color: "var(--fg-muted, #C0C0C0)",
          overflowX: "auto",
        }}
      >
        {content}
      </pre>
    </section>
  );
}

function PlaceholderPanel({
  title,
  body,
}: {
  title: string;
  body: string;
}): React.JSX.Element {
  return (
    <section
      style={{
        background: "var(--sheet-2)",
        border: "1px dashed var(--line)",
        borderRadius: "var(--radius-lg)",
        padding: 32,
        textAlign: "center",
      }}
    >
      <h3
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: "var(--fg, #fff)",
          margin: 0,
          marginBottom: 8,
        }}
      >
        {title}
      </h3>
      <p
        style={{
          fontSize: 13,
          color: "var(--fg-muted, #999)",
          margin: 0,
          lineHeight: 1.5,
          maxWidth: 480,
          marginInline: "auto",
        }}
      >
        {body}
      </p>
    </section>
  );
}

function DiffPanel({
  componentPath,
  hits,
}: {
  componentPath: string;
  hits: DiffHit[];
}): React.JSX.Element {
  const totalHits = hits.reduce((sum, h) => sum + h.matches, 0);
  return (
    <section
      style={{
        background: "var(--sheet-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        padding: 20,
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h3
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fg, #fff)",
            margin: 0,
          }}
        >
          Hardcoded Style-Hits
        </h3>
        <p
          style={{
            fontSize: 12,
            color: "var(--fg-muted, #999)",
            margin: 0,
            marginTop: 4,
          }}
        >
          {componentPath} · {totalHits} Treffer in 4 Pattern-Klassen
        </p>
      </header>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {hits.map((hit) => (
          <li
            key={hit.pattern}
            style={{
              padding: 12,
              background: "var(--sheet-3)",
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontWeight: 600,
                color: "var(--fg, #fff)",
              }}
            >
              <span>{hit.pattern}</span>
              <span
                style={{
                  color: hit.matches === 0 ? "#10B981" : "#F59E0B",
                }}
              >
                {hit.matches}
              </span>
            </div>
            {hit.examples.length > 0 ? (
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "8px 0 0",
                  fontFamily: "monospace",
                  color: "var(--fg-muted, #B0B0B0)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                {hit.examples.map((ex, i) => (
                  <li key={i}>{ex}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * RefactoredPanel — Welle 3 (2026-05-01).
 *
 * Rendert die echte refactored Card-Component live mit Mock-Payloads.
 * Zeigt: Tokens-bind, Spring-Easings, Press-Scale, srf-pop Mount-Animation.
 *
 * Cards mit Polling/Live-Effects (IteratePipeline, SubWorkstreams,
 * ConsensusAction, LivePipeline) werden ohne echten Backend-Workstream
 * gerendert — Polling läuft trocken (404/offline-tolerant), das schadet
 * dem Showcase nicht. Die Card zeigt ihren Loading/Empty-State.
 */
function RefactoredPanel({ kindId }: { kindId: string }): React.JSX.Element {
  return (
    <section
      style={{
        background: "var(--sheet-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h3
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fg, #fff)",
            margin: 0,
          }}
        >
          Refactored-Variante (live)
        </h3>
        <p
          style={{
            fontSize: 12,
            color: "var(--fg-muted, #999)",
            margin: 0,
          }}
        >
          Echtes Card-Component mit Mock-Payload · Token-bind, Spring-Easings,
          Press-Scale, srf-pop Mount-Animation.
        </p>
      </header>
      <div style={{ display: "flex", justifyContent: "center", padding: 8 }}>
        <RefactoredSample kindId={kindId} />
      </div>
    </section>
  );
}

function RefactoredSample({
  kindId,
}: {
  kindId: string;
}): React.JSX.Element {
  switch (kindId) {
    case "synthesis":
      return (
        <MilestoneCard
          headline="Welle 3 abgeschlossen"
          sub="5 Loud-Cards von Inline-Styles auf Token-bind CSS-Klassen migriert."
          bullets={[
            "MilestoneCard, SubWorkstreamsCard, IteratePipelineCard",
            "LivePipeline (2px-Slider-Bug auf var(--radius-xs) korrigiert)",
            "ConsensusActionCard (Layout-Migration, Logik unverändert)",
            "srf-pop Mount-Animation mit Spring-Bouncy",
            "Press-Scale auf allen Buttons via var(--press-scale)",
          ]}
          quality={5}
          costSaved="Inline-Hits 233 → 106 (-54%)"
          beforeAfter={{
            before: "11 CSSProperties-Konstanten + style={...}",
            after: "1 CSS-Klasse, alle Werte aus Tokens",
          }}
        />
      );
    case "iterate-roast":
      return (
        <IteratePipelineCard
          workstreamId="lab-mock-iterate"
          workspaceId="lab"
          workstreamName="Refactor Welle 3"
          maxVersion={5}
        />
      );
    case "sub-workstream":
      return (
        <SubWorkstreamsCard
          masterWorkstreamId="lab-mock-master"
          workspaceId="lab"
        />
      );
    case "auto-dispatch-stage":
      return (
        <LivePipeline
          workstreamId="lab-mock-pipeline"
          workspaceId="lab"
          masterTicketId="lab-mock-master"
          subTickets={[
            { id: "sub-a", title: "OnboardingForm Edge-Cases" },
            { id: "sub-b", title: "Stripe-Webhook Idempotency" },
            { id: "sub-c", title: "RLS-Policy Audit" },
          ]}
          href="#"
        />
      );
    case "streaming-bubble":
      return <StreamingBubbleMockShow />;
    case "bug-fix-swarm":
      // ConsensusActionCard als Showcase fuer disagreement-Modus.
      return (
        <ConsensusActionCard
          workstreamId="lab-mock-consensus"
          consensusLevel="disagreement"
          masterTicketId="lab-mock-master"
          outliers={[
            {
              cluster: "Race-Condition",
              summary:
                "Subscription-Stream raced mit Initial-Hydration. Reproduziert in 2/3 Diagnose-Spawns.",
            },
            {
              cluster: "Stale-Cache",
              summary:
                "Hot-Reload triggert kein Cache-Invalidate. Nur 1/3 Spawn meldet das.",
            },
            {
              cluster: "Migration-Idempotency",
              summary:
                "0048 enthält nicht-idempotente DDL. 1/3 Spawn als Root-Cause priorisiert.",
            },
          ]}
        />
      );
    default:
      return (
        <MilestoneCard
          headline="Sample für diesen Kind nicht hinterlegt"
          sub={`Kind: ${kindId}`}
        />
      );
  }
}

function TokensPanel({
  componentPath,
  tokens,
}: {
  componentPath: string;
  tokens: string[];
}): React.JSX.Element {
  return (
    <section
      style={{
        background: "var(--sheet-2)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        padding: 20,
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h3
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fg, #fff)",
            margin: 0,
          }}
        >
          Verwendete Design-Tokens
        </h3>
        <p
          style={{
            fontSize: 12,
            color: "var(--fg-muted, #999)",
            margin: 0,
            marginTop: 4,
          }}
        >
          {componentPath} · {tokens.length} unique CSS-Custom-Properties
        </p>
      </header>
      {tokens.length === 0 ? (
        <p
          style={{
            fontSize: 13,
            color: "var(--fg-muted, #999)",
            fontStyle: "italic",
          }}
        >
          {/* audit-tokens-ignore — dokumentarischer Text, kein echter Use */}
          Keine var(--token)-Referenzen gefunden — Component nutzt
          ausschliesslich hardcoded Styles. Siehe{" "}
          <a
            href="https://github.com/MaximilianGerhardt/lazing/blob/main/docs/SURFACE-STYLE-GUIDE.md"
            style={{ color: "var(--accent, #4a9eff)", textDecoration: "underline" }}
          >
            SURFACE-STYLE-GUIDE.md
          </a>{" "}
          (Section A: Wann welches Token?) fuer den Refactor-Plan.
        </p>
      ) : (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          {tokens.map((token) => (
            <code
              key={token}
              style={{
                padding: "4px 10px",
                background: "var(--sheet-3)",
                borderRadius: 999,
                fontSize: 11,
                color: "var(--fg, #fff)",
                fontFamily: "monospace",
              }}
            >
              {token}
            </code>
          ))}
        </div>
      )}
      <footer
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--line)",
          fontSize: 11,
          color: "var(--fg-muted, #999)",
          lineHeight: 1.6,
        }}
      >
        SOP:{" "}
        <a
          href="https://github.com/MaximilianGerhardt/lazing/blob/main/docs/SURFACE-STYLE-GUIDE.md"
          style={{ color: "var(--accent, #4a9eff)", textDecoration: "underline" }}
        >
          docs/SURFACE-STYLE-GUIDE.md
        </a>{" "}
        — Token-Bind, Inline-Style-Verbot, Apple-Pure-Checklist. Pre-Push:{" "}
        <code style={{ background: "var(--sheet-3)", padding: "1px 6px", borderRadius: 4 }}>
          pnpm lint:surfaces
        </code>
        .
      </footer>
    </section>
  );
}
