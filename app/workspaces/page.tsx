/**
 * /workspaces — Listen-Page aller Workspaces, gruppiert nach Org.
 *
 * Server-Component. Nutzt das gleiche Permissions-Model wie der TopNav-
 * Switcher (Org-Membership → sichtbare Workspaces) plus Solo-Mode-
 * Fallback für Single-User-Setups.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { CSSProperties } from "react";

import { getDb } from "@/db/client";
import { listAllOrgs } from "@/lib/orgs/repo";
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById } from "@/lib/users/repo";

export const dynamic = "force-dynamic";

interface WorkspaceRow {
  id: string;
  label: string;
  organization_id: string | null;
  description: string | null;
  archived: number;
  sensitivity: string | null;
}

export default async function WorkspacesListPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) redirect("/login?reason=workspaces-needs-login");
  const me = findActiveUserById(userId);
  if (!me) redirect("/login");

  const db = getDb();
  const allWs = db.$raw
    .prepare(
      `SELECT id, label, organization_id, description, archived, sensitivity
         FROM workspaces
        WHERE archived = 0
        ORDER BY label`,
    )
    .all() as WorkspaceRow[];

  const visible = allWs.filter((w) =>
    canReadWorkspace(getEffectiveWorkspaceRole(userId, w.id)),
  );

  const orgs = listAllOrgs({ includeArchived: true });
  const orgMap = new Map(orgs.map((o) => [o.id, o]));

  const groups = new Map<string, WorkspaceRow[]>();
  const orphan: WorkspaceRow[] = [];
  for (const w of visible) {
    if (w.organization_id && orgMap.has(w.organization_id)) {
      const list = groups.get(w.organization_id) ?? [];
      list.push(w);
      groups.set(w.organization_id, list);
    } else {
      orphan.push(w);
    }
  }

  // Sortiere Orgs: company first, dann clients, products, tools, archived
  const TYPE_RANK: Record<string, number> = {
    company: 0,
    client: 1,
    product: 2,
    tool: 3,
    private: 4,
    archived: 5,
  };
  const sortedOrgIds = Array.from(groups.keys()).sort((a, b) => {
    const oa = orgMap.get(a);
    const ob = orgMap.get(b);
    const ra = TYPE_RANK[oa?.type ?? ""] ?? 9;
    const rb = TYPE_RANK[ob?.type ?? ""] ?? 9;
    if (ra !== rb) return ra - rb;
    return (oa?.name ?? a).localeCompare(ob?.name ?? b, "de");
  });

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <header style={heroStyle}>
        <div style={crumbStyle}>Workspaces</div>
        <h1 style={titleStyle}>Alle Workspaces</h1>
        <p style={leadStyle}>
          {visible.length} sichtbar
          {orgs.length > 0
            ? ` · gruppiert nach ${sortedOrgIds.length} Organisation${
                sortedOrgIds.length === 1 ? "" : "en"
              }`
            : ""}
          .
        </p>
      </header>

      <section style={sectionsStyle}>
        {sortedOrgIds.map((orgId) => {
          const org = orgMap.get(orgId);
          const items = groups.get(orgId) ?? [];
          return (
            <div key={orgId} style={groupStyle}>
              <div style={groupHeaderStyle}>
                <Link
                  href={`/orgs/${encodeURIComponent(orgId)}`}
                  style={groupTitleStyle}
                >
                  {org?.name ?? orgId}
                </Link>
                <span style={groupTypeStyle}>{org?.type ?? "—"}</span>
                <span style={groupCountStyle}>{items.length}</span>
              </div>
              {org?.description ? (
                <p style={groupDescStyle}>{org.description}</p>
              ) : null}
              <div style={cardsGridStyle}>
                {items.map((w) => (
                  <WorkspaceCard key={w.id} ws={w} />
                ))}
              </div>
            </div>
          );
        })}

        {orphan.length > 0 ? (
          <div style={groupStyle}>
            <div style={groupHeaderStyle}>
              <span style={groupTitleStyle}>Ohne Organisation</span>
              <span style={groupCountStyle}>{orphan.length}</span>
            </div>
            <div style={cardsGridStyle}>
              {orphan.map((w) => (
                <WorkspaceCard key={w.id} ws={w} />
              ))}
            </div>
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div style={emptyStyle}>
            Du siehst keine Workspaces. Bitte einen Admin um Mitgliedschaft.
          </div>
        ) : null}
      </section>
    </main>
  );
}

function WorkspaceCard({ ws }: { ws: WorkspaceRow }): React.JSX.Element {
  return (
    <Link
      href={`/workspaces/${encodeURIComponent(ws.id)}`}
      style={cardStyle}
    >
      <div style={cardLabelStyle}>{ws.label}</div>
      <div style={cardIdStyle}>{ws.id}</div>
      {ws.description ? (
        <div style={cardDescStyle}>{ws.description}</div>
      ) : null}
      {ws.sensitivity === "high" ? (
        <span style={sensitivePillStyle}>privat</span>
      ) : null}
    </Link>
  );
}

const heroStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: "clamp(28px, 4vw, 56px)",
};
const crumbStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
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
  marginTop: 12,
  fontSize: "clamp(14px, 1.7vw, 17px)",
  color: "var(--ink-2)",
};
const sectionsStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 40,
  display: "flex",
  flexDirection: "column",
  gap: 36,
};
const groupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const groupHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};
const groupTitleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  color: "var(--ink)",
  textDecoration: "none",
  letterSpacing: "-0.005em",
};
const groupTypeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  padding: "2px 8px",
  borderRadius: 999,
  border: "0.5px solid var(--line-2)",
};
const groupCountStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--ink-3)",
  marginLeft: "auto",
};
const groupDescStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--ink-3)",
  lineHeight: 1.5,
  margin: 0,
};
const cardsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  gap: 12,
};
const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "16px 18px",
  borderRadius: 12,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
  textDecoration: "none",
  color: "inherit",
  position: "relative",
};
const cardLabelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: "var(--ink)",
  letterSpacing: "-0.005em",
};
const cardIdStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--ink-3)",
};
const cardDescStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "var(--ink-3)",
  lineHeight: 1.5,
};
const sensitivePillStyle: CSSProperties = {
  position: "absolute",
  top: 10,
  right: 10,
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  padding: "1px 6px",
  borderRadius: 999,
  border: "0.5px solid var(--a-private)",
  color: "var(--a-private)",
};
const emptyStyle: CSSProperties = {
  padding: 28,
  borderRadius: 14,
  border: "0.5px dashed var(--line-2)",
  color: "var(--ink-3)",
  fontSize: 14,
  textAlign: "center",
};
