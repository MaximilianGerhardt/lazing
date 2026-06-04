/**
 * /how — System guide. How does lazyOS fit together?
 *
 * Analogous to /design (component library), but as an architecture
 * explanation. Apple keynote style: lots of whitespace, large typography,
 * flow diagrams as inline SVG that become vertical stacks responsively on
 * mobile.
 *
 * Audience: Max while testing. Meant to give the mental model so every
 * UI action has its place in the overall system.
 */

import type { CSSProperties, ReactNode } from 'react';

import { SUB_PAGES, subPageSubline } from '../../lib/how/content';
import {
  altLocale,
  pickLocale,
  tr,
  UI_STRINGS,
  type Locale,
} from '../../lib/how/locale';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HowPage(props: PageProps) {
  const sp = await props.searchParams;
  const loc = pickLocale(sp.lang);

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <TopBar loc={loc} />
      <Hero loc={loc} />
      <ConceptGrid loc={loc} />
      <SectionFundamentals />
      <SectionLayers />
      <SectionFlowChat />
      <SectionFlowWorkstream />
      <SectionFlowTicket />
      <SectionVps />
      <SectionGlossary />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Top bar (locale toggle)
// ---------------------------------------------------------------------------

function TopBar(props: { loc: Locale }) {
  const ui = UI_STRINGS[props.loc];
  const otherLoc = altLocale(props.loc);
  const otherHref = `/how?lang=${otherLoc}`;
  return (
    <nav style={topBarStyle} aria-label="how-locale">
      <span style={{ flex: 1 }} />
      <a href={otherHref} style={topBarLangStyle}>
        <span style={{ opacity: 0.5 }}>{ui.languageSwitch}</span>
        <span style={topBarLangPillStyle(props.loc === 'de')}>DE</span>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <span style={topBarLangPillStyle(props.loc === 'en')}>EN</span>
      </a>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero(props: { loc: Locale }) {
  const isDe = props.loc === 'de';
  const ui = UI_STRINGS[props.loc];
  return (
    <header style={heroStyle}>
      <div
        className="t-kicker"
        style={{
          color: 'var(--a-now)',
          marginBottom: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <span style={{ width: 40, height: 1, background: 'var(--a-now)' }} />
        {ui.overviewKicker}
      </div>
      <h1 className="t-display" style={{ maxWidth: 1000 }}>
        {isDe ? (
          <>
            laz.ing — dein <span className="gradient-text">Workstream-OS</span>.
            <br />
            <span style={{ color: 'var(--ink-2)', fontWeight: 300 }}>
              Wie es denkt, arbeitet, sich verbindet.
            </span>
          </>
        ) : (
          <>
            laz.ing — your <span className="gradient-text">workstream OS</span>.
            <br />
            <span style={{ color: 'var(--ink-2)', fontWeight: 300 }}>
              How it thinks, works, connects.
            </span>
          </>
        )}
      </h1>
      <p style={leadStyle}>
        {isDe
          ? 'laz.ing ist eine PWA + ein VPS + Claude Code CLI in tmux + ein Multi-Agent-Layer. Diese Seite erklärt, was wann wo passiert. Die sieben Karten unten führen tiefer in die einzelnen Konzepte; darunter findest du die Architektur als Flussdiagramm.'
          : 'laz.ing is a PWA + a VPS + Claude Code CLI in tmux + a multi-agent layer. This page explains what happens, when, and where. The seven cards below dive into individual concepts; below that you find the architecture as a flow diagram.'}
      </p>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Concept Grid (7 cards)
// ---------------------------------------------------------------------------

function ConceptGrid(props: { loc: Locale }) {
  const isDe = props.loc === 'de';
  return (
    <section style={sectionStyle}>
      <div className="t-kicker" style={kickerStyle}>
        {isDe ? '00 · Konzepte' : '00 · Concepts'}
      </div>
      <h2 className="t-h2" style={{ maxWidth: 900, marginTop: 14 }}>
        {isDe
          ? 'Sieben Bausteine. Ein System.'
          : 'Seven building blocks. One system.'}
      </h2>
      <p style={leadStyle}>
        {isDe
          ? 'Jede Karte führt auf eine Sub-Seite mit Erklärung in Lang-Form. Klick rein um zu verstehen, was unter der UI passiert.'
          : 'Each card leads to a sub-page with a long-form explanation. Click in to understand what is happening under the UI.'}
      </p>
      <div style={conceptGridStyle}>
        {SUB_PAGES.map((p) => (
          <a
            key={p.slug}
            href={`/how/${p.slug}?lang=${props.loc}`}
            style={conceptCardStyle}
          >
            <div style={conceptCardSlugStyle}>{p.slug}</div>
            <div style={conceptCardTitleStyle}>{tr(props.loc, p.title)}</div>
            <div style={conceptCardSublineStyle}>
              {subPageSubline(props.loc, p.slug)}
            </div>
            <div style={conceptCardArrowStyle} aria-hidden="true">
              →
            </div>
          </a>
        ))}
        <a href={`/how?lang=${props.loc}#layers`} style={conceptCardStyle}>
          <div style={conceptCardSlugStyle}>architecture</div>
          <div style={conceptCardTitleStyle}>
            {isDe ? 'Architektur' : 'Architecture'}
          </div>
          <div style={conceptCardSublineStyle}>
            {isDe
              ? 'PWA · VPS · tmux · Claude'
              : 'PWA · VPS · tmux · Claude'}
          </div>
          <div style={conceptCardArrowStyle} aria-hidden="true">
            ↓
          </div>
        </a>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

function SectionFundamentals() {
  return (
    <Section
      kicker="01 · Fundamentals"
      title="Drei Schichten, eine Idee."
      lead="Frontend (PWA) sieht Max. VPS hält die Daten. Claude Code in tmux macht die Arbeit. Alles event-sourced — was passiert ist, wird nicht überschrieben, sondern als Event geloggt."
    >
      <ThreeColumnGrid>
        <Card
          icon="◐"
          title="PWA"
          subtitle="Vercel · Next.js 16 · React"
        >
          Was du auf iPhone/Browser siehst. Sendet Events, lauscht auf SSE,
          rendert Surfaces. Hat keinen direkten DB-Zugriff — alles läuft
          über das Backend. Offline-Cache nur für die App-Shell.
        </Card>
        <Card
          icon="◑"
          title="VPS"
          subtitle="SQLite · Drizzle · Node"
        >
          Eine SQLite-DB als Single-Source-of-Truth. Tickets, Workstreams,
          Skills, Routines, Workspaces — alles im Event-Log. APIs lesen +
          schreiben über Drizzle. Persistent, schnell, lokal.
        </Card>
        <Card
          icon="◒"
          title="tmux + Claude Code"
          subtitle="MAX-Plan · keine API-Keys"
        >
          Pro Workspace eine persistente tmux-Session. Drin läuft `claude`
          (CLI). Tier-Spawns bekommen eigene tmux-Panes — überleben damit
          Service-Restarts, App-Schließen, alles.
        </Card>
      </ThreeColumnGrid>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Layers — vertical SVG stack that stays on mobile
// ---------------------------------------------------------------------------

function SectionLayers() {
  return (
    <Section
      id="layers"
      kicker="02 · Schicht-Diagramm"
      title="Vom Klick bis zum Spawn."
      lead="Was passiert wenn du im Chat etwas tippst? Sechs Stationen, jede mit klarer Rolle."
    >
      <div style={layerStackStyle}>
        <LayerBar
          label="Du tippst im Chat"
          sub="lib/chat/ChatShell.tsx · Composer + Auto-Suggest"
          accent="var(--a-private)"
        />
        <LayerArrow />
        <LayerBar
          label="POST /api/chat/stream"
          sub="proxy → tmux-pane des Workspaces"
          accent="var(--a-now)"
        />
        <LayerArrow />
        <LayerBar
          label="claude (CLI) in tmux"
          sub="MAX-Plan · keine API-Credits · System-Prompt eingespielt"
          accent="var(--a-clientb)"
        />
        <LayerArrow />
        <LayerBar
          label="Antwort als SSE zurück"
          sub="text-chunks + tool-events + <surface:KIND>{...} Tags"
          accent="var(--a-clientb)"
        />
        <LayerArrow />
        <LayerBar
          label="surface-parser splittet"
          sub="text → Markdown · surface → typisierte Component"
          accent="var(--a-now)"
        />
        <LayerArrow />
        <LayerBar
          label="SurfaceRenderer rendert"
          sub="MilestoneCard · LiveSwarm · LiveWorkflowSurface · TierChoice…"
          accent="var(--a-private)"
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Flow: Chat → plan detection → tier spawn
// ---------------------------------------------------------------------------

function SectionFlowChat() {
  return (
    <Section
      kicker="03 · Plan erkannt"
      title="Wenn du einen großen Plan tippst."
      lead='Tippst du z.B. "Plane mir den Refactor von …", erkennt das System das selber. Statt direkt zu antworten, kommt eine Tier-Choice-Card.'
    >
      <FlowDiagram
        steps={[
          {
            n: 1,
            label: 'Du sendest Anfrage',
            detail: 'Min. 3 Sub-Themen oder Trigger-Wort',
          },
          {
            n: 2,
            label: 'Lead-Agent erkennt Plan',
            detail: 'Emittiert <surface:tier-choice>',
          },
          {
            n: 3,
            label: 'Tier-Choice-Card erscheint',
            detail: 'Schnell · Balanced · Tief · Eigene Werte',
          },
          {
            n: 4,
            label: 'Du klickst Preset',
            detail: 'POST /api/workstreams + spawn',
          },
          {
            n: 5,
            label: 'Master-Plan-Ticket entsteht',
            detail: 'Workstream WS-… verlinkt es',
          },
          {
            n: 6,
            label: 'Tier-Spawn läuft',
            detail: 'N Opus + M Sonnet + K Haiku in tmux',
          },
          {
            n: 7,
            label: 'LiveSwarm-Card live',
            detail: 'Heatmap zeigt jeden Slot · running → consensus',
          },
          {
            n: 8,
            label: 'Lead-Synthesis',
            detail: 'Ein finaler Plan + User-Sicht + offene Fragen',
          },
        ]}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Flow: Workstream container
// ---------------------------------------------------------------------------

function SectionFlowWorkstream() {
  return (
    <Section
      kicker="04 · Workstream"
      title="Ein Container für eine Anfrage."
      lead="Ein Workstream bündelt: 1 Master-Plan-Ticket + N Sub-Tickets + 1 Claude-Session + Tier-Mix-Config + Cost + Quality. Nicht jedes Ticket braucht einen Workstream — nur wenn Multi-Agent angeworfen wird."
    >
      <ContainerDiagram
        center={{ label: 'Workstream WS-…', sub: 'aktiv · €1.20 · Q 4.2' }}
        nodes={[
          { label: 'Master-Plan-Ticket', sub: 'TCK-… · review' },
          { label: 'Sub-Ticket #1', sub: 'TCK-… · draft' },
          { label: 'Sub-Ticket #2', sub: 'TCK-… · approved' },
          { label: 'Claude-Session', sub: 'tmux · uuid-…' },
          { label: 'Tier-Mix', sub: '2 · 6 · 12' },
          { label: 'Skill-Mix', sub: 'UX · Risk · Critic …' },
        ]}
      />
      <p style={{ ...leadStyle, marginTop: 24 }}>
        Workstream ist eine first-class Entity — du findest sie unter{' '}
        <Link href="/workstreams">Workstreams</Link>. Toggle Liste/Kanban
        sortiert nach Status.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Flow: Ticket FSM
// ---------------------------------------------------------------------------

function SectionFlowTicket() {
  return (
    <Section
      kicker="05 · Ticket-Workflow"
      title="Fünf Schritte. Klare Übergänge."
      lead="Jedes Ticket lebt in einer FSM: draft → review → approved → executed → closed. Plus Alt-Pfad rejected. User darf approven + rejecten, Agents nicht. Übergänge werden als Events geloggt — kein Update überschreibt Historie."
    >
      <PipelineDiagram
        steps={[
          { n: 1, label: 'Entwurf', sub: 'draft' },
          { n: 2, label: 'Review', sub: 'review' },
          { n: 3, label: 'Freigegeben', sub: 'approved' },
          { n: 4, label: 'Ausgeführt', sub: 'executed' },
          { n: 5, label: 'Geschlossen', sub: 'closed' },
        ]}
        rejected={{ label: 'Abgelehnt', sub: 'rejected · reopen möglich' }}
      />
      <p style={{ ...leadStyle, marginTop: 24 }}>
        Im Chat siehst du die Pipeline live als{' '}
        <code style={codeStyle}>&lt;surface:workflow-pipeline&gt;</code>{' '}
        Card. Sie aktualisiert sich ohne Reload — sobald ein Workflow-Event
        am Ticket auftaucht, springt der aktive Step weiter.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// VPS / tmux / Claude Code
// ---------------------------------------------------------------------------

function SectionVps() {
  return (
    <Section
      kicker="06 · VPS · tmux · CC"
      title="Was läuft auf dem Server?"
      lead="laz.ing bündelt vier Prozesse auf dem VPS. Drei sind Standard, einer ist die geheime Sauce."
    >
      <ThreeColumnGrid>
        <Card icon="▣" title="Next.js Server" subtitle="Port 3030 · API + UI">
          Liefert die PWA, terminiert HTTP + SSE, schreibt Events in die
          DB. Restart-fähig — Workstreams laufen im tmux weiter.
        </Card>
        <Card
          icon="▤"
          title="SQLite (lazyos.db)"
          subtitle="data/lazyos.db · WAL"
        >
          Drizzle ORM, Migrations idempotent, Single-File. Backup =
          rsync. Kein Cloud-Vendor-Lock.
        </Card>
        <Card icon="◫" title="tmux-Sessions" subtitle="lazyos-ws-{workspaceId}">
          Pro Workspace eine persistente Session mit Pane-0 (Chat-
          Transcript) + Pane-1 (Bash). Tier-Spawns bekommen weitere
          tmux-Sessions <code>lazyos-spawn-…</code>.
        </Card>
        <Card icon="◉" title="claude (CLI)" subtitle="MAX-Plan · headless">
          Pro Spawn ein <code>claude --print --model X --max-turns 1</code>.
          Output landet als file, Orchestrator pollt
          <code>.done</code>-Flag. Damit überleben Spawns Service-Restarts
          ohne Verlust.
        </Card>
        <Card icon="◇" title="Skills" subtitle="lib/agents/skills/service.ts">
          16 Built-Ins seeden in DB beim ersten Boot. Pro Spawn-Slot wird
          ein Skill ausgewählt — z.B. <code>UX</code> oder <code>Critic</code>.
          Du kannst eigene unter <Link href="/skills">/skills</Link> anlegen.
        </Card>
        <Card icon="◆" title="Push-Engine" subtitle="Web-Push · Service-Worker">
          Wenn ein Tier-Spawn @max mentioned (z.B. Disagreement), kommt
          ein iOS-Push. Subscription liegt in
          <code>data/push-subscriptions.json</code>.
        </Card>
      </ThreeColumnGrid>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

function SectionGlossary() {
  const items: Array<{ term: string; def: string }> = [
    {
      term: 'Workstream',
      def: 'Container für eine User-Anfrage. Bündelt Master-Ticket + Sub-Tickets + Claude-Session + Tier-Mix + Cost + Quality.',
    },
    {
      term: 'Ticket',
      def: 'Atomare Aufgabe. Lebt in einer FSM (draft → … → closed). Kann zu einem Workstream gehören oder standalone sein.',
    },
    {
      term: 'Skill',
      def: 'Fokus-Linse für einen Spawn-Slot. Beispiele: UX, Architecture, Cost, Risk, Critic. 16 Built-Ins + beliebig eigene.',
    },
    {
      term: 'Tier',
      def: 'Modell-Kapazität. Opus (teuer, tief) · Sonnet (mittel) · Haiku (schnell). MAX-Plan, keine Credits.',
    },
    {
      term: 'Effort',
      def: 'Reasoning-Tiefe. xhigh · high · medium · low. Default für Skills · überschreibbar pro Workstream.',
    },
    {
      term: 'Surface',
      def: 'Typisierte UI-Card. Vom Agent emittiert als <surface:KIND>{json}. Beispiele: tier-choice, milestone, workflow-pipeline, live-swarm.',
    },
    {
      term: 'Event',
      def: 'Was passiert ist. Wird ins Log geschrieben, nie überschrieben. Tickets entstehen aus Event-Projektion.',
    },
    {
      term: 'tmux-Pane',
      def: 'Persistenter Terminal-Pane auf dem VPS. Eine Pane pro Workspace · Spawn · Sub-Agent. Überlebt App-Schließen + Restart.',
    },
    {
      term: 'MAX-Plan',
      def: 'Anthropic-Subscription die Claude Code CLI nutzt. Keine API-Credits, kein Token-Limit pro Request — aber Rate-Limit-Schutz nötig.',
    },
    {
      term: 'Auto-Mode',
      def: 'Toggle in der TopBar. Aktiv → System spawnt automatisch Tier-Mix bei jeder nicht-trivialen Anfrage. Inaktiv → User wählt manuell.',
    },
  ];
  return (
    <Section
      kicker="07 · Glossar"
      title="Begriffe."
      lead="Wenn etwas im Interface auftaucht und du dich fragst was es heißt — hier."
    >
      <dl style={glossaryStyle}>
        {items.map((it) => (
          <div key={it.term} style={glossaryItemStyle}>
            <dt style={glossaryTermStyle}>{it.term}</dt>
            <dd style={glossaryDefStyle}>{it.def}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// ===========================================================================
// Building blocks
// ===========================================================================

function Section(props: {
  id?: string;
  kicker: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <section id={props.id} style={sectionStyle}>
      <div className="t-kicker" style={kickerStyle}>
        {props.kicker}
      </div>
      <h2 className="t-h2" style={{ maxWidth: 900, marginTop: 14 }}>
        {props.title}
      </h2>
      <p style={leadStyle}>{props.lead}</p>
      <div style={{ marginTop: 32 }}>{props.children}</div>
    </section>
  );
}

function Card(props: {
  icon: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <article style={cardStyle}>
      <div style={cardIconStyle}>{props.icon}</div>
      <h3 style={cardTitleStyle}>{props.title}</h3>
      <div style={cardSubtitleStyle}>{props.subtitle}</div>
      <p style={cardBodyStyle}>{props.children}</p>
    </article>
  );
}

function ThreeColumnGrid(props: { children: ReactNode }) {
  return <div style={threeGridStyle}>{props.children}</div>;
}

function LayerBar(props: { label: string; sub: string; accent: string }) {
  return (
    <div style={layerBarStyle(props.accent)}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={layerLabelStyle}>{props.label}</div>
        <div style={layerSubStyle}>{props.sub}</div>
      </div>
      <span style={layerDotStyle(props.accent)} />
    </div>
  );
}

function LayerArrow() {
  return (
    <div style={layerArrowStyle} aria-hidden="true">
      <svg width="14" height="22" viewBox="0 0 14 22">
        <path
          d="M7 0v18M2 14l5 6 5-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function FlowDiagram(props: {
  steps: Array<{ n: number; label: string; detail: string }>;
}) {
  return (
    <ol style={flowGridStyle} aria-label="Plan-Erkennungs-Flow">
      {props.steps.map((s) => (
        <li key={s.n} style={flowCardStyle}>
          <div style={flowNumStyle}>{s.n.toString().padStart(2, '0')}</div>
          <div style={flowLabelStyle}>{s.label}</div>
          <div style={flowDetailStyle}>{s.detail}</div>
        </li>
      ))}
    </ol>
  );
}

function ContainerDiagram(props: {
  center: { label: string; sub: string };
  nodes: Array<{ label: string; sub: string }>;
}) {
  return (
    <div style={containerDiagramStyle}>
      <div style={containerCenterStyle}>
        <div style={containerCenterLabelStyle}>{props.center.label}</div>
        <div style={containerCenterSubStyle}>{props.center.sub}</div>
      </div>
      <div style={containerNodesStyle}>
        {props.nodes.map((n) => (
          <div key={n.label} style={containerNodeStyle}>
            <div style={containerNodeLabelStyle}>{n.label}</div>
            <div style={containerNodeSubStyle}>{n.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PipelineDiagram(props: {
  steps: Array<{ n: number; label: string; sub: string }>;
  rejected: { label: string; sub: string };
}) {
  return (
    <div style={pipelineWrapStyle}>
      <ol style={pipelineGridStyle}>
        {props.steps.map((s, i) => (
          <li key={s.n} style={pipelineStepStyle}>
            <span style={pipelineNumStyle}>{s.n}</span>
            <span style={pipelineLabelStyle}>{s.label}</span>
            <code style={pipelineCodeStyle}>{s.sub}</code>
            {i < props.steps.length - 1 ? <span style={pipelineArrowStyle}>→</span> : null}
          </li>
        ))}
      </ol>
      <div style={pipelineRejectedStyle}>
        <span style={{ color: 'var(--a-danger)' }}>●</span>
        <strong style={{ color: 'var(--ink)', fontWeight: 500 }}>
          {props.rejected.label}
        </strong>
        <code style={pipelineCodeStyle}>{props.rejected.sub}</code>
      </div>
    </div>
  );
}

function Link(props: { href: string; children: ReactNode }) {
  return (
    <a
      href={props.href}
      style={{
        color: 'var(--a-now)',
        textDecoration: 'underline',
        textDecorationThickness: '0.5px',
        textUnderlineOffset: 3,
      }}
    >
      {props.children}
    </a>
  );
}

// ===========================================================================
// Styles
// ===========================================================================

const topBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  paddingTop: 'clamp(20px, 3vw, 36px)',
  marginBottom: 0,
  flexWrap: 'wrap',
};

const topBarLangStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.04em',
  color: 'var(--ink-3)',
  textDecoration: 'none',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
};

function topBarLangPillStyle(active: boolean): CSSProperties {
  return {
    color: active ? 'var(--a-now)' : 'var(--ink-3)',
    fontWeight: active ? 600 : 400,
  };
}

const conceptGridStyle: CSSProperties = {
  marginTop: 32,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const conceptCardStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: 'clamp(18px, 2.5vw, 26px)',
  borderRadius: 16,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 90%, transparent)',
  textDecoration: 'none',
  minHeight: 140,
};

const conceptCardSlugStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--a-now)',
};

const conceptCardTitleStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--ink)',
  letterSpacing: '-0.01em',
};

const conceptCardSublineStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: 'var(--ink-3)',
  letterSpacing: '-0.005em',
};

const conceptCardArrowStyle: CSSProperties = {
  position: 'absolute',
  right: 18,
  bottom: 16,
  fontSize: 18,
  color: 'var(--ink-3)',
};

const heroStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 'clamp(40px, 6vw, 80px)',
  marginBottom: 56,
};

const leadStyle: CSSProperties = {
  marginTop: 18,
  maxWidth: 720,
  fontSize: 'clamp(15px, 1.6vw, 17px)',
  lineHeight: 1.55,
  color: 'var(--ink-2)',
  letterSpacing: '-0.005em',
};

const sectionStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 'clamp(48px, 7vw, 96px)',
};

const kickerStyle: CSSProperties = {
  color: 'var(--a-now)',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'var(--sheet-3)',
  color: 'var(--ink)',
};

// Card grid
const threeGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 14,
};

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 'clamp(18px, 2.5vw, 28px)',
  borderRadius: 16,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 90%, transparent)',
  minWidth: 0,
};

const cardIconStyle: CSSProperties = {
  fontSize: 28,
  color: 'var(--a-now)',
  marginBottom: 4,
};

const cardTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  color: 'var(--ink)',
  letterSpacing: '-0.01em',
};

const cardSubtitleStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
  letterSpacing: '0.04em',
};

const cardBodyStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 14,
  color: 'var(--ink-2)',
  lineHeight: 1.55,
};

// Layer-Stack
const layerStackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 0,
  maxWidth: 720,
};

function layerBarStyle(accent: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: 'clamp(14px, 2vw, 22px) clamp(16px, 2.5vw, 26px)',
    borderRadius: 14,
    border: `0.5px solid color-mix(in srgb, ${accent} 50%, var(--line-2))`,
    background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 8%, var(--sheet-2)), var(--sheet-2))`,
  };
}

const layerLabelStyle: CSSProperties = {
  fontSize: 'clamp(14px, 1.8vw, 17px)',
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const layerSubStyle: CSSProperties = {
  marginTop: 3,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
  letterSpacing: '0.02em',
};

function layerDotStyle(accent: string): CSSProperties {
  return {
    width: 10,
    height: 10,
    borderRadius: 999,
    background: accent,
    boxShadow: `0 0 12px color-mix(in srgb, ${accent} 60%, transparent)`,
    flexShrink: 0,
  };
}

const layerArrowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  color: 'var(--ink-3)',
  padding: '4px 0',
};

// Flow diagram
const flowGridStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 12,
  counterReset: 'flow',
};

const flowCardStyle: CSSProperties = {
  position: 'relative',
  padding: '18px 18px 16px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
};

const flowNumStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  color: 'var(--a-now)',
  marginBottom: 4,
};

const flowLabelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const flowDetailStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
  lineHeight: 1.45,
};

// Container diagram (Workstream)
const containerDiagramStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 24,
};

const containerCenterStyle: CSSProperties = {
  padding: '24px 32px',
  borderRadius: 18,
  border: '0.5px solid color-mix(in srgb, var(--a-now) 60%, var(--line-2))',
  background: 'color-mix(in oklab, var(--a-now) 10%, var(--sheet-2))',
  boxShadow: '0 0 24px color-mix(in srgb, var(--a-now) 18%, transparent)',
  textAlign: 'center',
};

const containerCenterLabelStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--ink)',
  letterSpacing: '-0.01em',
};

const containerCenterSubStyle: CSSProperties = {
  marginTop: 4,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const containerNodesStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 10,
  width: '100%',
  maxWidth: 720,
};

const containerNodeStyle: CSSProperties = {
  padding: '12px 14px',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  textAlign: 'center',
};

const containerNodeLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const containerNodeSubStyle: CSSProperties = {
  marginTop: 2,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
};

// Pipeline diagram
const pipelineWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const pipelineGridStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 8,
  alignItems: 'stretch',
};

const pipelineStepStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '14px 8px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  textAlign: 'center',
};

const pipelineNumStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: 999,
  background: 'var(--card-2)',
  color: 'var(--ink)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  fontWeight: 600,
};

const pipelineLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--ink)',
};

const pipelineCodeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.02em',
};

const pipelineArrowStyle: CSSProperties = {
  position: 'absolute',
  right: -8,
  top: '50%',
  transform: 'translateY(-50%)',
  fontSize: 14,
  color: 'var(--ink-4)',
};

const pipelineRejectedStyle: CSSProperties = {
  marginTop: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--a-danger) 10%, transparent)',
  border: '0.5px solid color-mix(in srgb, var(--a-danger) 30%, var(--line-2))',
  fontSize: 12,
  color: 'var(--ink-2)',
  flexWrap: 'wrap',
};

// Glossary
const glossaryStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 16,
};

const glossaryItemStyle: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
};

const glossaryTermStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
  color: 'var(--a-now)',
  textTransform: 'uppercase',
};

const glossaryDefStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 13,
  color: 'var(--ink-2)',
  lineHeight: 1.5,
};
