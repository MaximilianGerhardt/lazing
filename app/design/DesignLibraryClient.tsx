"use client";

import type { CSSProperties, ReactNode } from "react";
import { BRAND_NAME } from "@/lib/brand";
import { CmdBar, CmdSuggest, type CmdSuggestion } from "@/lib/ui/cmd";
import { Chat, MsgUser, MsgAssistant, MsgCard } from "@/lib/ui/cht";
import { Decision } from "@/lib/ui/dec";
import { ChartContainer, LineChart, BarChart, StatsRow, Heatmap } from "@/lib/ui/chr";
import { Ticket } from "@/lib/ui/tck";
import { Invoice } from "@/lib/ui/inv";
import { Pill, PillRow } from "@/lib/ui/pil";
import { ContextBand } from "@/lib/ui/cbd";
import { Teammate } from "@/lib/ui/tmc";
import { Pipeline } from "@/lib/ui/pip";
import { Terminal } from "@/lib/ui/trm";
import { Engine } from "@/lib/ui/eng";
import { HeartbeatPulse } from "@/lib/ui/hbt";
import { QuickChoice } from "@/lib/ui/qck";
import { Toast } from "@/lib/ui/tst";
import { DesignReviewTicket } from "./DesignReviewTicket";

const SUGGESTIONS: CmdSuggestion[] = [
  {
    id: "s1",
    kind: "act",
    label: "Rechnung schreiben · Sprint 14",
    detail: "aus Leistungsnachweis · DATEV-ready",
    shortcut: "↵",
    onSelect: () => {},
  },
  {
    id: "s2",
    kind: "nav",
    label: "Rechnungen Übersicht",
    detail: "14 offen · € 42 180 fällig",
    shortcut: "Cmd",
    onSelect: () => {},
  },
  {
    id: "s3",
    kind: "doc",
    label: "Rechnung RE-2026-0141 öffnen",
    detail: "clientb GmbH · gestern gesendet",
    shortcut: "↵",
    onSelect: () => {},
  },
];

export default function DesignLibraryClient() {
  return (
    <main className="sheet">
      <header style={{ maxWidth: 1100, marginTop: "clamp(40px, 6vw, 80px)", marginBottom: 56 }}>
        <div
          className="t-kicker"
          style={{
            color: "var(--a-now)",
            marginBottom: 24,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <span style={{ width: 40, height: 1, background: "var(--a-now)" }} />
          Component Library · Manifest v1.0 · Phase 1
        </div>
        <h1 className="t-display" style={{ maxWidth: 1000 }}>
          16 <span className="gradient-text">Bausteine</span>,
          <br />
          <span style={{ color: "var(--ink-2)", fontWeight: 300 }}>live im Dark.</span>
        </h1>
        <p
          style={{
            marginTop: 24,
            maxWidth: 680,
            fontSize: 17,
            lineHeight: 1.55,
            color: "var(--ink-2)",
          }}
        >
          Alle Komponenten rendern gegen das {BRAND_NAME} v1.0 Token-System. Jede Kategorie mit ID
          referenzierbar. Unten: Review-Ticket — Checkliste, direkter Test-Link, Feedback-Feld.
        </p>
      </header>

      {/* A · CMD */}
      <Section id="CMD-01" title="Ambient Command Bar" desc="Spotlight-Geist ohne Shortcut. Context-Chip rechts, optionaler Mic-Button, Suggestion-Dropdown darunter.">
        <div style={{ width: "100%", maxWidth: 640 }}>
          <CmdBar placeholder="Sprich oder tippe — ich verstehe den Kontext…" contextLabel="Nord-Sparkasse" micEnabled />
          <CmdSuggest suggestions={SUGGESTIONS} activeIndex={0} listboxId="design-cmd-suggest" />
        </div>
      </Section>

      {/* B · CHT */}
      <Section id="CHT-01" title="Transformative Chat" desc="User-Bubble Orange, Assistant-Text Glas, inline-Card als Slot für Chart/Decision/Invoice/Ticket.">
        <Chat>
          <MsgUser>hi, wie ist der Stand bei Nord-Sparkasse?</MsgUser>
          <MsgAssistant>
            Sprint 14 zu <b>72%</b> durch. Ein kritischer Punkt: Schwelle für <b>KR-007</b> wartet auf dich.
          </MsgAssistant>
          <MsgCard ariaLabel="Sprint-Fortschritt">
            <ChartContainer title="Sprint 14 · Fortschritt" value="72%" sub="14 Modelle · 3 Skills · Woche 2/3">
              <LineChart
                title=""
                data={[20, 28, 32, 45, 52, 58, 70, 72, 78, 85, 90]}
                showEndDot
                height={100}
              />
            </ChartContainer>
          </MsgCard>
        </Chat>
      </Section>

      {/* C · DEC */}
      <Section id="DEC-01" title="Decision Card" desc="Multi-Option mit optionalem Counter. Recommended-Option orange hervorgehoben. Keyboard-navigierbar (Arrow + Enter).">
        <div style={{ width: "100%", maxWidth: 440 }}>
          <Decision
            headline="Freigabe-Schwelle KR-007"
            sub="Schwarm n=50 · klarer Konsens ausser 2 Outlier."
            options={[
              { id: "a", label: "Q2/2026", sublabel: "mit Revision", counter: "42/50", recommended: true },
              { id: "b", label: "Q3/2026", sublabel: "mehr Puffer", counter: "6/50" },
              { id: "c", label: "Sofort abschalten", sublabel: "Outlier-Meinung", counter: "2/50" },
            ]}
            deepLink={{ label: "Dossier öffnen", onClick: () => {} }}
          />
        </div>
      </Section>

      {/* D · CHR (alle 4) */}
      <Section id="CHR-01/02/03/04" title="Charts · Line · Bars · Stats · Heatmap" desc="Reine SVG/Grid, keine Runtime-Lib. Median-Marker + Outlier-Highlights.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, width: "100%", maxWidth: 1000 }}>
          <ChartContainer title="Sprint 14 · Fortschritt" value="72%" sub="Letzte 10 Tage" axisLeft="Tag 1" axisCenter="5" axisRight="heute">
            <LineChart title="" data={[18, 25, 30, 42, 50, 56, 68, 72, 82, 90]} showEndDot />
          </ChartContainer>
          <ChartContainer title="Kalibrierungs-Fehler · σ" value="1.78" valueVariant="warn" sub="50 Agenten · Median markiert" axisLeft="1.2σ" axisCenter="MEDIAN" axisRight="2.4σ">
            <BarChart
              title=""
              bars={[
                { height: 8, variant: "outlier" },
                { height: 14 }, { height: 22 }, { height: 32 }, { height: 48 }, { height: 68 },
                { height: 82 }, { height: 95, variant: "median" }, { height: 75 },
                { height: 50 }, { height: 32 }, { height: 18 }, { height: 12 },
                { height: 6, variant: "outlier" },
              ]}
            />
          </ChartContainer>
          <StatsRow
            stats={[
              { value: "38/50", label: "Durch" },
              { value: "σ 0.14", label: "Varianz" },
              { value: "2", label: "Outlier" },
            ]}
          />
          <ChartContainer title="Schwarm-Konsens" value="n=50" sub="Konsens · Median · Outlier · Running">
            <Heatmap
              title=""
              cells={Array.from({ length: 50 }, (_, i) => {
                if (i < 20) return { variant: "consensus" };
                if (i === 24) return { variant: "median" };
                if (i === 28 || i === 29) return { variant: "running" };
                if (i >= 30 && i <= 32) return { variant: "running" };
                return { variant: "empty" };
              })}
            />
          </ChartContainer>
        </div>
      </Section>

      {/* E · TCK */}
      <Section id="TCK-01" title="Tickets · 4 Zustände" desc="Left-Bar glüht in Status-Farbe (orange/green/red/grey). Prio-Badge, Footer mit Fälligkeit + Tags.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16, width: "100%", maxWidth: 1100 }}>
          <Ticket
            id="TCK-4281"
            status="open"
            prio="P1 · HOCH"
            title="Freigabe Schwelle KR-007 steht aus"
            body="Schwarm-Konsens bei 84% für Q2-Re-Kalibrierung. Menschliche Freigabe nötig bevor Audit-Bericht an BaFin geht."
            segment="Nord-Sparkasse"
            assignee="Lena K. · Legal"
            due="14.05."
          />
          <Ticket
            id="TCK-4280"
            status="done"
            prio="ERLEDIGT"
            title="Leistungsnachweis Sprint 14 generiert"
            body="DIN-5008-konform · 85,8 h Personen-Äquivalenz · an Kunde gesendet."
            segment="Nord-Sparkasse"
            assignee="Claude Code"
            due="vor 42 Min"
          />
          <Ticket
            id="TCK-4279"
            status="danger"
            prio="ESKAL · 3×"
            title="DATEV-Sync gescheitert"
            body="Monats-Rechnungslauf konnte 3× nicht abgeschlossen werden. AUTH_EXPIRED · Token 00:00 abgelaufen."
            segment="Eigene · Intern"
            assignee="Scheduler"
            due="JETZT"
          />
        </div>
      </Section>

      {/* F · INV */}
      <Section id="INV-01" title="Invoice Card" desc="Inline im Chat renderbar, mit DATEV-CTA. Status-Varianten: Entwurf · Gesendet · Bezahlt · Überfällig.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 32, width: "100%", maxWidth: 900 }}>
          <Invoice
            status="draft"
            number="RE-2026-0142"
            title="Sprint 14 · KR-Audit"
            subtitle="Nord-Sparkasse AG · Fällig 15.05.2026"
            lines={[
              { label: "KR-Modell-Prüfung", detail: "14 Modelle · Validierung", amount: "8 580,00" },
              { label: "Legal & Compliance", detail: "DSGVO · MaRisk · KWG", amount: "2 240,00" },
              { label: "Bericht & Export", detail: "DIN-5008 konform", amount: "960,00" },
            ]}
            totalAmount="14 018,20 €"
            onAdjust={() => {}}
            onPrimary={() => {}}
          />
          <Invoice
            status="paid"
            number="RE-2026-0140"
            title="clientb · März-Leistungen"
            subtitle="Bezahlt · 18.04.2026"
            lines={[]}
            totalAmount="6 280,00 €"
            totalLabel="Betrag"
          />
        </div>
      </Section>

      {/* G · PIL */}
      <Section id="PIL-01" title="Context Pills · 7 Varianten" desc="Projekt-Pills (north/clientb/own/private) + Engine-Pills (claude/codex) + Error. Glow-Dot links.">
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
          <PillRow>
            <Pill variant="north">Nord-Sparkasse</Pill>
            <Pill variant="clientb">clientb GmbH</Pill>
            <Pill variant="own">Eigene</Pill>
            <Pill variant="private">Privat</Pill>
          </PillRow>
          <PillRow>
            <Pill variant="claude">Claude Code · live</Pill>
            <Pill variant="codex">Codex · running</Pill>
            <Pill variant="error">Fehler · DATEV</Pill>
          </PillRow>
        </div>
      </Section>

      {/* H · TMC */}
      <Section id="TMC-01" title="Teammate Cards · Lead / Standard / Add" desc="Skills mit Gesicht. Lead mit Orange-Glow, Standard plain, Add als Dashed-Slot.">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, maxWidth: 800 }}>
          <Teammate
            variant="lead"
            avatarGlyph="§"
            avatarAccent
            name="Lena K. · Legal"
            role="DSGVO · MaRisk · KWG"
            tags={["§25a", "Art.6"]}
            stats={{ counter: "12 Checks heute", status: "läuft", statusVariant: "live" }}
          />
          <Teammate
            variant="standard"
            avatarGlyph="Σ"
            name="Arne R. · Risk"
            role="Modelle · Kalibrierung"
            tags={["Basel-IV"]}
            stats={{ counter: "50 Läufe", status: "ETA 2m", statusVariant: "eta" }}
          />
          <Teammate
            variant="add"
            avatarGlyph="+"
            name="Skill hinzufügen"
            role="Marketplace · 9 verfügbar"
          />
        </div>
      </Section>

      {/* I · PIP */}
      <Section id="PIP-01" title="Pipeline Steps" desc="Jede Station sichtbar. Done grün, Running orange mit Glow, Waiting grau.">
        <div style={{ width: "100%", maxWidth: 640 }}>
          <Pipeline
            steps={[
              { num: 1, title: "YouTube-Transkript ziehen", subtitle: "yt-dlp · 24:18 · 3 842 Wörter", status: "done" },
              { num: 2, title: "Transkript bereinigen", subtitle: "Codex · Filler entfernt · 2.1k", status: "done" },
              { num: 3, title: "Blog-Artikel schreiben", subtitle: "Claude · Skill blog-de-v2 · läuft 38s", status: "running" },
              { num: 4, title: "Heygen · Avatar-Video", subtitle: "wartet auf Skript", status: "waiting" },
            ]}
          />
        </div>
      </Section>

      {/* J · TRM */}
      <Section id="TRM-01" title="Terminal Block" desc="Shell-Wahrheit. Farb-getaggte Zeilen (prompt/host/error/ok/claude/codex) + blinkender Cursor.">
        <div style={{ width: "100%", maxWidth: 640 }}>
          <Terminal
            lines={[
              { spans: [
                { text: "nick@vps", level: "host" },
                { text: ":" },
                { text: "~/lazyos", level: "prompt" },
                { text: "$ claude-code status" },
              ]},
              { spans: [{ text: "session: 0x8f3a · stalled 4m", level: "dim" }]},
              { spans: [{ text: "error: context window near limit", level: "error" }]},
              { text: " " },
              { spans: [
                { text: "nick@vps", level: "host" },
                { text: ":" },
                { text: "~/lazyos", level: "prompt" },
                { text: "$ claude-code --resume --compact" },
              ]},
              { spans: [{ text: "compacting… 62k → 18k", level: "dim" }]},
              { spans: [{ text: "resumed · context healthy", level: "ok" }]},
              { spans: [
                { text: "nick@vps", level: "host" },
                { text: ":" },
                { text: "~/lazyos", level: "prompt" },
                { text: "$ " },
              ], cursor: true },
            ]}
          />
        </div>
      </Section>

      {/* K · ENG */}
      <Section id="ENG-01/02" title="Engine Cards · Claude · Codex" desc="Live-Laufzeiten. Linker Rand glüht in Engine-Farbe, Wave-Bars zeigen Aktivität.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 760 }}>
          <Engine
            type="claude"
            name="Claude Code"
            status="running"
            meta={<>Opus 4.7 · <b>Skills</b> × 2 · Subagents × 3<br/>Kontext <b>62k</b>/200k · 14m live</>}
          />
          <Engine
            type="codex"
            name="Codex CLI"
            status="running"
            meta={<>GPT-5.1 · Parallel-Runner × 2<br/>Tokens <b>8.4k</b>/Task · ETA 45s</>}
          />
        </div>
      </Section>

      {/* L · HBT */}
      <Section id="HBT-01" title="Heartbeat Pulse" desc="Der Puls eines Projekts. Atmender Kern + 2 Ripple-Wellen in Violett.">
        <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
          <HeartbeatPulse count={8} label="aktiv" ariaLabel="8 Projekte aktiv" />
        </div>
      </Section>

      {/* M · QCK */}
      <Section id="QCK-01" title="Quick Choice" desc="Drei Knöpfe, eine Entscheidung. Primary orange, default glass.">
        <QuickChoice
          options={[
            { id: "yes", label: "Ja", sublabel: "empfohlen", primary: true, onSelect: () => {} },
            { id: "later", label: "Q3", sublabel: "später", onSelect: () => {} },
            { id: "dossier", label: "Dossier", sublabel: "prüfen", onSelect: () => {} },
          ]}
        />
      </Section>

      {/* O · TST */}
      <Section id="TST-01" title="Notification Toast" desc="Glass-Notification mit Icon. Varianten: default / ok / warn / err.">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 800 }}>
          <Toast
            variant="default"
            iconGlyph="L"
            title="Rechnung gesendet"
            body="RE-2026-0142 · € 14.018,20 · DATEV aktualisiert"
          />
          <Toast
            variant="err"
            iconGlyph="!"
            title="DATEV-Token läuft ab"
            body="Heute 00:00 · jetzt erneuern"
          />
        </div>
      </Section>

      {/* P · CBD */}
      <Section id="CBD-01" title="Context Band" desc="Dauerhafte Orientierung unter Command-Bar. Projekt-Pill + Breadcrumb.">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 480 }}>
          <ContextBand pillVariant="north" pillLabel="Nord-Sparkasse" breadcrumb="Sprint 14 · KR-007 Prüfung" />
          <ContextBand pillVariant="clientb" pillLabel="clientb GmbH" breadcrumb="AVV-Nachtrag · Legal-Review" />
          <ContextBand pillVariant="own" pillLabel="Eigene" breadcrumb="Content-Pipeline · YT → Blog" />
        </div>
      </Section>

      {/* Review Ticket */}
      <section style={{ marginTop: 120, marginBottom: 80, maxWidth: 720 }}>
        <div
          className="t-kicker"
          style={{
            color: "var(--a-now)",
            marginBottom: 18,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <span style={{ width: 40, height: 1, background: "var(--a-now)" }} />
          Review · Phase 1 · zum Abschluss
        </div>
        <h2 className="t-h2" style={{ fontSize: 32, marginBottom: 14 }}>
          Teste die <em style={{ fontStyle: "italic", fontWeight: 300, color: "var(--ink-2)" }}>Library</em>.
        </h2>
        <p style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.55, marginBottom: 32 }}>
          Checkliste unten abhaken, ggf. anmerken was kippt. Klick &bdquo;Anpassen&rdquo; wenn etwas korrigiert werden soll —
          startet autonomen Fix-Agent im Hintergrund.
        </p>
        <DesignReviewTicket />
      </section>
    </main>
  );
}

function Section({
  id,
  title,
  desc,
  children,
}: {
  id: string;
  title: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`sec-${id}`}
      style={{ marginBottom: 96, maxWidth: 1200, scrollMarginTop: 24 }}
    >
      <div style={{ marginBottom: 28, display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <span
          className="mono"
          style={{
            fontSize: 11,
            padding: "3px 9px",
            background: "color-mix(in oklab, var(--a-now) 15%, transparent)",
            color: "var(--a-now)",
            border: "0.5px solid color-mix(in oklab, var(--a-now) 30%, transparent)",
            borderRadius: 5,
            letterSpacing: "0.05em",
            fontWeight: 600,
          }}
        >
          {id}
        </span>
        <h2
          id={`sec-${id}`}
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--ink)",
          }}
        >
          {title}
        </h2>
      </div>
      <p style={{ fontSize: 13, color: "var(--ink-2)", maxWidth: 640, marginBottom: 24, lineHeight: 1.55 }}>
        {desc}
      </p>
      <div style={frameStyle}>{children}</div>
    </section>
  );
}

const frameStyle: CSSProperties = {
  padding: 32,
  borderRadius: 20,
  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  border: "0.5px solid var(--line-2)",
};
