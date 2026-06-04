/**
 * /orgs/manage — management list of all organizations the current user
 * is a member of. Segmented by type. Phase IA.3.
 *
 * This page is NOT the default landing — it is used for creating,
 * archiving, and type-switching at the org level. The default view is
 * `/orgs/[id]` (= active org as default), reachable via the
 * OrgSwitcher in the TopNav.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { CSSProperties } from "react";

import { listOrgsForUser, listOrgWorkspaces } from "@/lib/orgs/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById } from "@/lib/users/repo";
import { OrgsCreateButton } from "../CreateButton";
import { getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

interface OrgListItem {
  id: string;
  name: string;
  type: string;
  description: string | null;
  logoUrl: string | null;
  brandColors: string[] | null;
  workspaceCount: number;
}

interface Section {
  key: string;
  title: string;
  hint: string;
  items: OrgListItem[];
}

const SECTION_DEFS: Array<{
  key: string;
  title: string;
  hint: string;
  match: (type: string) => boolean;
}> = [
  {
    key: "own",
    title: "Eigenprojekte",
    hint: "Die Holding und ihre Produkte — eigene Marken.",
    match: (t) => t === "company" || t === "product",
  },
  {
    key: "clients",
    title: "Kunden",
    hint: "Externe Auftraggeber, jeweils ein eigener Container.",
    match: (t) => t === "client",
  },
  {
    key: "tools",
    title: "Tools",
    hint: "Interne Werkzeuge ohne eigene Markenidentität.",
    match: (t) => t === "tool",
  },
  {
    key: "private",
    title: "Privat",
    hint: "Persönliche Workspaces ohne Geschäftsbezug.",
    match: (t) => t === "private",
  },
];

export default async function OrgsListPage() {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=orgs-needs-login");
  }
  const user = findActiveUserById(userId);
  if (!user) {
    redirect("/login?reason=user-not-found");
  }
  const allOrgs = listOrgsForUser(userId);

  const items: OrgListItem[] = allOrgs.map((o) => ({
    id: o.id,
    name: o.name,
    type: o.type,
    description: o.description ?? null,
    logoUrl: o.logoUrl ?? null,
    brandColors: o.brandColors ?? null,
    workspaceCount: listOrgWorkspaces(o.id).length,
  }));

  const sections: Section[] = SECTION_DEFS.map((def) => ({
    key: def.key,
    title: def.title,
    hint: def.hint,
    items: items
      .filter((it) => def.match(it.type))
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
  })).filter((s) => s.items.length > 0);

  const otherItems = items
    .filter((it) => !SECTION_DEFS.some((d) => d.match(it.type)))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  if (otherItems.length > 0) {
    sections.push({
      key: "other",
      title: "Sonstige",
      hint: "Organisationen ohne klassischen Type.",
      items: otherItems,
    });
  }

  const totalWs = items.reduce((sum, it) => sum + it.workspaceCount, 0);
  const tt = await getServerT();

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <header style={heroStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={crumbStyle}>{tt("org.manage.crumb")}</div>
            <h1 style={titleStyle}>{tt("org.manage.title")}</h1>
            <p style={leadStyle}>
              {tt("org.manage.lead", { count: items.length, totalWs })}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <Link href="/onboarding/kunde" style={newCustomerEntryStyle}>
              Neuer Kunde
            </Link>
            <OrgsCreateButton />
          </div>
        </div>
      </header>

      <section style={sectionsStyle}>
        {items.length === 0 ? (
          <div style={emptyStyle}>
            Du bist (noch) in keiner Organisation Mitglied. Wenn du Owner
            bist, melde dich neu an damit dein Cookie auf die echte User-ID
            remapped wird.
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.key} style={groupStyle}>
              <div style={groupHeaderStyle}>
                <span style={groupTitleStyle}>{section.title}</span>
                <span style={groupCountStyle}>{section.items.length}</span>
              </div>
              <p style={groupHintStyle}>{section.hint}</p>
              <div style={gridStyle}>
                {section.items.map((o) => (
                  <Link
                    key={o.id}
                    href={`/orgs/${encodeURIComponent(o.id)}`}
                    style={cardStyle}
                  >
                    <div style={cardTopStyle}>
                      {o.logoUrl ? (
                        <img
                          src={o.logoUrl}
                          alt=""
                          style={{ width: 36, height: 36, objectFit: "contain" }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 8,
                            background: o.brandColors?.[0] ?? "#222",
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={cardTitleStyle}>{o.name}</div>
                        <div style={cardTypeRowStyle}>
                          <span style={cardTypeStyle}>{o.type}</span>
                          <span style={cardWsCountStyle}>
                            {o.workspaceCount} WS
                          </span>
                        </div>
                      </div>
                    </div>
                    {o.description ? (
                      <p style={cardDescStyle}>{o.description}</p>
                    ) : null}
                  </Link>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </main>
  );
}

const heroStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: "clamp(28px, 4vw, 56px)",
};
// Bundle-B (2026-06-03): quiet ghost entry to the guided „Neuer Kunde" wizard.
const newCustomerEntryStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  padding: "10px 18px",
  borderRadius: 10,
  border: "0.5px solid var(--line-2)",
  background: "transparent",
  color: "var(--ink-2)",
  fontSize: 13,
  fontWeight: 500,
  textDecoration: "none",
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
  marginTop: 14,
  maxWidth: 720,
  fontSize: "clamp(15px, 1.7vw, 18px)",
  lineHeight: 1.55,
  color: "var(--ink-2)",
};
const sectionsStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: "clamp(36px, 5vw, 56px)",
  display: "flex",
  flexDirection: "column",
  gap: 40,
};
const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const groupHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};
const groupTitleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  color: "var(--ink)",
  letterSpacing: "-0.005em",
};
const groupCountStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  color: "var(--ink-3)",
  padding: "2px 8px",
  borderRadius: 999,
  border: "0.5px solid var(--line-2)",
};
const groupHintStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--ink-3)",
  lineHeight: 1.5,
};
const gridStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 14,
};
const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "16px 18px",
  borderRadius: 14,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
  textDecoration: "none",
  color: "inherit",
  transition: "border-color 160ms",
};
const cardTopStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};
const cardTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 500,
  color: "var(--ink)",
  letterSpacing: "-0.005em",
};
const cardTypeRowStyle: CSSProperties = {
  marginTop: 4,
  display: "flex",
  alignItems: "center",
  gap: 10,
};
const cardTypeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};
const cardWsCountStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--ink-3)",
};
const cardDescStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: "var(--ink-2)",
  margin: 0,
};
const emptyStyle: CSSProperties = {
  padding: "36px 24px",
  borderRadius: 14,
  border: "0.5px dashed var(--line-2)",
  color: "var(--ink-3)",
  fontSize: 14,
  lineHeight: 1.55,
  maxWidth: 600,
};
