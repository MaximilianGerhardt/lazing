/**
 * /innovate/[scope] — Phase IN Mockup-Page (2026-04-29).
 *
 * Marketing-USP-Demo. Zeigt was passiert WENN der User den Innovation-
 * Button drückt — heute Konzept, kein echtes Spawn. Code-Skeleton-
 * Endpoint /api/innovate gibt 501 zurück mit dokumentiertem Vertrag.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { CSSProperties } from "react";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById } from "@/lib/users/repo";
import {
  PERSONA_DESCRIPTIONS,
  SCOPE_LABELS,
  type InnovatePersona,
  type InnovateScope,
} from "@/lib/innovate/contract";
import { getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

const VALID_SCOPES: InnovateScope[] = [
  "org",
  "workspace",
  "ticket",
  "tickets-list",
  "workstream",
];

const PERSONAS: InnovatePersona[] = [
  "ux-analyst",
  "motion-director",
  "design-thinking",
  "critic",
  "product-owner",
];

export default async function InnovateMockupPage({
  params,
}: {
  params: Promise<{ scope: string }>;
}): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=innovate-needs-login");
  }
  const user = findActiveUserById(userId);
  if (!user) {
    redirect("/login");
  }

  const { scope: rawScope } = await params;
  const scope: InnovateScope =
    (VALID_SCOPES as string[]).includes(rawScope)
      ? (rawScope as InnovateScope)
      : "workspace";

  const scopeLabel = SCOPE_LABELS[scope];
  const tt = await getServerT();

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <header style={heroStyle}>
        <div style={crumbStyle}>{tt("innovate.crumb")}</div>
        <h1 style={titleStyle}>
          {tt("innovate.hero.q1", { scope: scopeLabel.toLowerCase() })}
          <br />
          {tt("innovate.hero.q2")}
        </h1>
        <p style={leadStyle}>{tt("innovate.hero.lead")}</p>
        <div style={statusBannerStyle}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>
            {tt("innovate.status.label")}
          </span>
          <span>{tt("innovate.status.body")}</span>
        </div>
      </header>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>{tt("innovate.section.flow")}</h2>
        <pre style={flowStyle}>
{`Du drückst Innovation
        ↓
3 Designer-Agents bekommen aktuellen UI-Snapshot + Brief
        ↓
Parallel-Generation von je 1 alternativer Mockup-Spec
        ↓
Cross-Roast (RA-Pattern) zwischen den 3 Designs
        ↓
V_final-Mockups in Karten — du pickst
        ↓
Pick wird in Tickets umgesetzt (Sub-Plan-Sniper)`}
        </pre>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>{tt("innovate.section.personas")}</h2>
        <div style={personasGridStyle}>
          {PERSONAS.map((p) => (
            <article key={p} style={personaCardStyle}>
              <div style={personaNameStyle}>{p}</div>
              <p style={personaDescStyle}>{PERSONA_DESCRIPTIONS[p]}</p>
            </article>
          ))}
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>{tt("innovate.section.usp")}</h2>
        <div style={uspGridStyle}>
          <div style={uspCardStyle}>
            <div style={uspLabelStyle}>{tt("innovate.usp.them.label")}</div>
            <p style={uspBodyStyle}>{tt("innovate.usp.them.body")}</p>
          </div>
          <div style={{ ...uspCardStyle, borderColor: "var(--a-now)" }}>
            <div style={{ ...uspLabelStyle, color: "var(--a-now)" }}>{tt("innovate.usp.us.label")}</div>
            <p style={uspBodyStyle}>{tt("innovate.usp.us.body")}</p>
          </div>
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>{tt("innovate.section.preview")}</h2>
        <div style={scopesRowStyle}>
          {VALID_SCOPES.map((s) => (
            <a
              key={s}
              href={`/innovate/${encodeURIComponent(s)}`}
              style={{
                ...scopePillStyle,
                ...(s === scope
                  ? { borderColor: "var(--a-now)", color: "var(--ink)" }
                  : {}),
              }}
            >
              {SCOPE_LABELS[s]}
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}

const heroStyle: CSSProperties = {
  maxWidth: 900,
  marginTop: "clamp(28px, 4vw, 56px)",
};
const crumbStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};
const titleStyle: CSSProperties = {
  marginTop: 12,
  fontSize: "clamp(34px, 5vw, 60px)",
  letterSpacing: "-0.035em",
  lineHeight: 1.04,
};
const leadStyle: CSSProperties = {
  marginTop: 18,
  maxWidth: 720,
  fontSize: "clamp(15px, 1.7vw, 18px)",
  lineHeight: 1.55,
  color: "var(--ink-2)",
};
const statusBannerStyle: CSSProperties = {
  marginTop: 28,
  padding: "14px 18px",
  borderRadius: 12,
  border: "0.5px dashed var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 60%, transparent)",
  color: "var(--ink-2)",
  fontSize: 13,
  lineHeight: 1.55,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxWidth: 720,
};
const codeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  background: "color-mix(in oklab, var(--ink) 8%, transparent)",
  padding: "1px 6px",
  borderRadius: 4,
};
const sectionStyle: CSSProperties = {
  maxWidth: 900,
  marginTop: 64,
  display: "flex",
  flexDirection: "column",
  gap: 18,
};
const sectionTitleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 500,
  letterSpacing: "-0.015em",
  color: "var(--ink)",
};
const flowStyle: CSSProperties = {
  margin: 0,
  padding: "20px 22px",
  borderRadius: 14,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  lineHeight: 1.7,
  color: "var(--ink-2)",
  whiteSpace: "pre",
  overflowX: "auto",
};
const personasGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  gap: 12,
};
const personaCardStyle: CSSProperties = {
  padding: "16px 18px",
  borderRadius: 12,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 70%, transparent)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const personaNameStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--a-now)",
};
const personaDescStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ink-2)",
};
const hintStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ink-3)",
  margin: 0,
  maxWidth: 720,
};
const uspGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 12,
};
const uspCardStyle: CSSProperties = {
  padding: "20px 22px",
  borderRadius: 14,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 70%, transparent)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const uspLabelStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};
const uspBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.55,
  color: "var(--ink)",
};
const scopesRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};
const scopePillStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 999,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 50%, transparent)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.04em",
  color: "var(--ink-3)",
  textDecoration: "none",
};
