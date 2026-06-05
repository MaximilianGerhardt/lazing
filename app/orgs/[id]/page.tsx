/**
 * /orgs/[id] — org detail with 4 tabs (Phase ORG SP-5).
 *
 * Tabs (?tab=…):
 *   - overview (default) — stats + responsible person + description
 *   - members             — member list + invite
 *   - workspaces          — connected workspaces
 *   - branding            — logo, colors, imprint, VAT ID (for the PDF pipeline SP-7)
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import type { CSSProperties } from "react";

import {
  findOrgById,
  findUserOrgMembership,
  listAllOrgs,
  listOrgMembers,
  listOrgWorkspaces,
  listSubOrgs,
  type OrgFull,
} from "@/lib/orgs/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById, findUserById } from "@/lib/users/repo";
import { OrgCoreEditor } from "./OrgCoreEditor";
import { OrgMembersTab } from "./MembersTab";
import { OrgBrandingTab } from "./BrandingTab";
import { OrgGithubPanel } from "./OrgGithubPanel";
import { OrgConnectionsTab } from "./OrgConnectionsTab";
import { AttachWorkspaceCard } from "./AttachWorkspaceCard";
import { CreateWorkspaceCard } from "./CreateWorkspaceCard";
import { SECTION_DEFS, pickSectionKey } from "@/lib/orgs/sections";

export const dynamic = "force-dynamic";

type Tab =
  | "workspaces"
  | "overview"
  | "members"
  | "branding"
  | "github"
  | "connections";

// Phase IA.2 — the default tab is now `workspaces`. The tab order reflects
// this: workspaces first, then overview/members/branding.
const TAB_LABELS: Record<Tab, string> = {
  workspaces: "Workspaces",
  overview: "Overview",
  members: "Members",
  branding: "Branding",
  github: "GitHub",
  connections: "Connections",
};

export default async function OrgDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id: rawId } = await params;
  const sp = await searchParams;
  const id = decodeURIComponent(rawId);
  const tab: Tab =
    sp.tab === "overview" ||
    sp.tab === "members" ||
    sp.tab === "branding" ||
    sp.tab === "github" ||
    sp.tab === "connections"
      ? sp.tab
      : "workspaces";

  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=orgs-needs-login");
  }
  const me = findActiveUserById(userId);
  if (!me) redirect("/login");

  const org = findOrgById(id);
  if (!org) notFound();

  const myMembership = findUserOrgMembership(userId, id);
  if (!myMembership) {
    return (
      <main className="sheet">
        <div style={notMemberStyle}>
          Du bist kein Mitglied von <strong>{org.name}</strong>.
          <br />
          <Link href="/orgs" style={{ color: "var(--a-now)" }}>
            ← zurück zu Orgs
          </Link>
        </div>
      </main>
    );
  }

  const isAdminOrFounder =
    myMembership.role === "founder" || myMembership.role === "admin";

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <header style={heroStyle}>
        <div style={crumbStyle}>
          <Link href="/orgs" style={{ color: "inherit", textDecoration: "none" }}>
            Organisationen
          </Link>{" "}
          ›{" "}
          <span style={{ color: "var(--ink-2)" }}>{org.name}</span>
        </div>
        <h1 style={titleStyle}>{org.name}</h1>
        {org.description ? (
          <p style={leadStyle}>{org.description}</p>
        ) : (
          <p style={{ ...leadStyle, fontStyle: "italic", color: "var(--ink-3)" }}>
            Keine Kurzbeschreibung — füg sie unter „Branding" hinzu.
          </p>
        )}
      </header>

      <nav style={tabsRowStyle} aria-label="Org-Tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <Link
            key={t}
            href={
              t === "workspaces"
                ? `/orgs/${encodeURIComponent(id)}`
                : `/orgs/${encodeURIComponent(id)}?tab=${t}`
            }
            style={tabBtnStyle(tab === t)}
            aria-current={tab === t ? "page" : undefined}
            replace
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      <section style={tabContentStyle}>
        {tab === "overview" ? (
          <OverviewTab org={org} canEdit={isAdminOrFounder} />
        ) : null}
        {tab === "members" ? (
          <OrgMembersTab orgId={id} canInvite={isAdminOrFounder} />
        ) : null}
        {tab === "workspaces" ? (
          <WorkspacesTab
            orgId={id}
            orgName={org.name}
            canAttach={isAdminOrFounder}
          />
        ) : null}
        {tab === "branding" ? (
          <OrgBrandingTab org={org} canEdit={isAdminOrFounder} />
        ) : null}
        {tab === "github" ? (
          <OrgGithubPanel orgId={id} isAdmin={isAdminOrFounder} />
        ) : null}
        {tab === "connections" ? (
          <OrgConnectionsTab orgId={id} isAdmin={isAdminOrFounder} />
        ) : null}
      </section>
    </main>
  );
}

function OverviewTab({
  org,
  canEdit,
}: {
  org: OrgFull;
  canEdit: boolean;
}) {
  const responsible = org.responsibleUserId
    ? findUserById(org.responsibleUserId)
    : null;
  const members = listOrgMembers(org.id);
  const wsCount = listOrgWorkspaces(org.id).length;
  const allOrgs = listAllOrgs({ includeArchived: true });

  return (
    <div style={{ maxWidth: 800, width: "100%", minWidth: 0 }}>
      <div style={statsRowStyle}>
        <Stat label="Mitglieder" value={String(members.length)} />
        <Stat label="Workspaces" value={String(wsCount)} />
        <Stat label="Typ" value={org.type} />
        {responsible ? (
          <Stat label="Verantwortlich" value={responsible.displayName} />
        ) : (
          <Stat label="Verantwortlich" value="—" />
        )}
      </div>

      <div style={{ marginTop: 28 }}>
        <OrgCoreEditor
          orgId={org.id}
          canEdit={canEdit}
          initial={{
            name: org.name,
            description: org.description ?? "",
            type: org.type,
            parentId: org.parentId,
          }}
          parentOptions={allOrgs.map((o) => ({ id: o.id, name: o.name }))}
        />
      </div>

      {org.imprintMd ? (
        <div style={{ marginTop: 32 }}>
          <h3 style={sectionTitleStyle}>Impressum</h3>
          <pre style={imprintStyle}>{org.imprintMd}</pre>
        </div>
      ) : null}

      {org.addressLines && org.addressLines.length > 0 ? (
        <div style={{ marginTop: 24 }}>
          <h3 style={sectionTitleStyle}>Anschrift</h3>
          <pre style={imprintStyle}>{org.addressLines.join("\n")}</pre>
        </div>
      ) : null}
    </div>
  );
}

interface WsItem {
  id: string;
  label: string;
  description: string | null;
  sensitivity: string;
  type: string;
  archived: boolean;
}

/**
 * Phase IA consolidation 2026-04-29: shows sub-org cards instead of direct
 * workspaces. Rendered when the current org has sub-orgs (e.g.
 * Example Company with Example App/Demo PV/...).
 */
function SubOrgsView({
  parentOrgId,
  parentOrgName,
  subOrgs,
  canAttach,
}: {
  parentOrgId: string;
  parentOrgName: string;
  subOrgs: OrgFull[];
  canAttach: boolean;
}) {
  const items = subOrgs.map((o) => {
    const ws = listOrgWorkspaces(o.id).filter(
      (w) => !w.id.startsWith("__org_root__:") && w.id !== "__root__",
    );
    return {
      id: o.id,
      name: o.name,
      type: o.type,
      description: o.description ?? null,
      logoUrl: o.logoUrl ?? null,
      brandColors: o.brandColors ?? null,
      paletteIndex: o.paletteIndex,
      workspaceCount: ws.length,
      workspaceLabels: ws.slice(0, 3).map((w) => w.label).join(" · "),
    };
  });

  const sections: Array<{
    key: string;
    title: string;
    hint: string;
    items: typeof items;
  }> = SECTION_DEFS.map((def) => ({
    key: def.key,
    title: def.title,
    hint: def.hint,
    items: items
      .filter((it) => def.match(it.type))
      .sort((a, b) => a.name.localeCompare(b.name, "de")),
  })).filter((s) => s.items.length > 0);

  const other = items
    .filter((it) => !pickSectionKey(it.type))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
  if (other.length > 0) {
    sections.push({
      key: "other",
      title: "Sonstige",
      hint: "Sub-Orgs ohne klassischen Type.",
      items: other,
    });
  }

  return (
    <div style={{ maxWidth: 1100, display: "flex", flexDirection: "column", gap: 36 }}>
      <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13, lineHeight: 1.55 }}>
        {parentOrgName} hat {subOrgs.length} Sub-Organisation{subOrgs.length === 1 ? "" : "en"}.
        Klick auf eine Karte öffnet die Sub-Org mit ihren Workspaces.
      </p>
      {sections.map((section) => (
        <div key={section.key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 500, color: "var(--ink)" }}>
              {section.title}
            </span>
            <span style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--ink-3)",
              padding: "2px 8px",
              borderRadius: 999,
              border: "0.5px solid var(--line-2)",
            }}>{section.items.length}</span>
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-3)" }}>{section.hint}</p>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 14,
          }}>
            {section.items.map((o) => (
              <Link
                key={o.id}
                href={`/orgs/${encodeURIComponent(o.id)}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                  padding: "16px 18px",
                  borderRadius: 14,
                  border: "0.5px solid var(--line-2)",
                  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  {o.logoUrl ? (
                    <img src={o.logoUrl} alt="" style={{ width: 36, height: 36, objectFit: "contain" }} />
                  ) : (
                    <div style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: o.brandColors?.[0] ?? `var(--palette-${o.paletteIndex}, #222)`,
                      flexShrink: 0,
                    }} />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 500, color: "var(--ink)" }}>
                      {o.name}
                    </div>
                    <div style={{
                      marginTop: 4,
                      display: "flex",
                      gap: 10,
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      color: "var(--ink-3)",
                    }}>
                      <span style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {o.type}
                      </span>
                      <span>{o.workspaceCount} WS</span>
                    </div>
                  </div>
                </div>
                {o.description ? (
                  <p style={{
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.45,
                    color: "var(--ink-2)",
                  }}>{o.description}</p>
                ) : null}
                {o.workspaceLabels ? (
                  <div style={{
                    fontSize: 12,
                    color: "var(--ink-3)",
                    fontStyle: "italic",
                  }}>{o.workspaceLabels}</div>
                ) : null}
              </Link>
            ))}
          </div>
        </div>
      ))}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        <CreateWorkspaceCard
          orgId={parentOrgId}
          orgName={parentOrgName}
          canCreate={canAttach}
        />
        <AttachWorkspaceCard
          orgId={parentOrgId}
          orgName={parentOrgName}
          canAttach={canAttach}
        />
      </div>
    </div>
  );
}

function WorkspacesTab({
  orgId,
  orgName,
  canAttach,
}: {
  orgId: string;
  orgName: string;
  canAttach: boolean;
}) {
  // Phase IA consolidation 2026-04-29: if the org has sub-orgs, we show
  // sub-org cards (segmented by type) instead of direct workspaces.
  // Top-level "Example Company" → cards for Example App/example-tool/Demo PV/...
  // Sub-org "Demo PV" → real workspace cards (CRM, Web).
  const subOrgs = listSubOrgs(orgId);

  if (subOrgs.length > 0) {
    return (
      <SubOrgsView
        parentOrgId={orgId}
        parentOrgName={orgName}
        subOrgs={subOrgs}
        canAttach={canAttach}
      />
    );
  }

  const rawWorkspaces = listOrgWorkspaces(orgId);
  // Phase IA.4 — the org-root pseudo-workspace (`__org_root__:<id>`) is
  // filtered out of this list, because it does not represent a normal WS.
  const visibleWs = rawWorkspaces.filter(
    (w) => !w.id.startsWith("__org_root__:") && w.id !== "__root__",
  );

  // The workspace type comes from the `accent` column or a tag — today
  // we use the `accent` column as a rough type annotation. For sections
  // we use the org type as a fallback (all workspaces of a client org
  // are "client" if no dedicated type column exists).
  const items: WsItem[] = visibleWs.map((w) => ({
    id: w.id,
    label: w.label,
    description: w.description ?? null,
    sensitivity: w.sensitivity ?? "low",
    // Phase IA consolidation 2026-04-29: workspace_type is the real
    // type annotation (company/product/client/tool/private/default).
    type:
      (w as { workspaceType?: string; workspace_type?: string }).workspaceType ??
      (w as { workspace_type?: string }).workspace_type ??
      "default",
    archived: Boolean(w.archived),
  }));

  // Section logic: group by pickSectionKey(workspace.type), the rest
  // lands in "Other". Sorting per section is alphabetical.
  const sections: Array<{
    key: string;
    title: string;
    hint: string;
    items: WsItem[];
  }> = SECTION_DEFS.map((def) => ({
    key: def.key,
    title: def.title,
    hint: def.hint,
    items: items
      .filter((it) => def.match(it.type))
      .sort((a, b) => a.label.localeCompare(b.label, "de")),
  })).filter((s) => s.items.length > 0);

  const otherItems = items
    .filter((it) => !pickSectionKey(it.type))
    .sort((a, b) => a.label.localeCompare(b.label, "de"));
  if (otherItems.length > 0) {
    sections.push({
      key: "other",
      title: "Sonstige",
      hint: "Workspaces ohne Type-Annotation.",
      items: otherItems,
    });
  }

  return (
    <div style={{ maxWidth: 1000, display: "flex", flexDirection: "column", gap: 32 }}>
      {visibleWs.length === 0 ? (
        <div style={{ color: "var(--ink-3)", fontSize: 14 }}>
          Keine Workspaces dieser Organisation zugeordnet. Lege unten einen an.
        </div>
      ) : (
        sections.map((section) => (
          <div key={section.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{
                fontSize: 16,
                fontWeight: 500,
                color: "var(--ink)",
                letterSpacing: "-0.005em",
              }}>{section.title}</span>
              <span style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--ink-3)",
                padding: "2px 8px",
                borderRadius: 999,
                border: "0.5px solid var(--line-2)",
              }}>{section.items.length}</span>
            </div>
            <p style={{
              margin: 0,
              fontSize: 13,
              color: "var(--ink-3)",
              lineHeight: 1.5,
            }}>{section.hint}</p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 12,
              }}
            >
              {section.items.map((w) => (
                <Link
                  key={w.id}
                  href={`/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(w.id)}`}
                  style={{
                    padding: "14px 16px",
                    borderRadius: 12,
                    border: "0.5px solid var(--line-2)",
                    background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
                    textDecoration: "none",
                    color: "inherit",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
                    {w.label}
                  </div>
                  <div style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: "var(--ink-3)",
                  }}>{w.id}</div>
                  {w.description ? (
                    <div style={{
                      marginTop: 4,
                      fontSize: 12,
                      color: "var(--ink-3)",
                      lineHeight: 1.45,
                    }}>{w.description}</div>
                  ) : null}
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        <CreateWorkspaceCard
          orgId={orgId}
          orgName={orgName}
          canCreate={canAttach}
        />
        <AttachWorkspaceCard
          orgId={orgId}
          orgName={orgName}
          canAttach={canAttach}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
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
  color: "var(--ink-3)",
};
const titleStyle: CSSProperties = {
  marginTop: 14,
  fontSize: "clamp(34px, 5vw, 60px)",
  letterSpacing: "-0.035em",
  lineHeight: 1.02,
};
const leadStyle: CSSProperties = {
  marginTop: 14,
  maxWidth: 720,
  fontSize: "clamp(15px, 1.7vw, 18px)",
  lineHeight: 1.55,
  color: "var(--ink-2)",
};
const tabsRowStyle: CSSProperties = {
  maxWidth: "100%",
  marginTop: "clamp(40px, 6vw, 72px)",
  display: "flex",
  gap: 4,
  padding: 4,
  borderRadius: 999,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 70%, transparent)",
  alignSelf: "flex-start",
  width: "fit-content",
  // Mobile: scroll horizontally when tabs don't fit, instead of breaking.
  overflowX: "auto",
  flexWrap: "nowrap",
};
function tabBtnStyle(active: boolean): CSSProperties {
  return {
    padding: "8px 18px",
    borderRadius: 999,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    textDecoration: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
    color: active ? "var(--ink)" : "var(--ink-3)",
    background: active
      ? "color-mix(in oklab, var(--a-now) 18%, transparent)"
      : "transparent",
  };
}
const tabContentStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 28,
};
const statsRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 14,
};
const statStyle: CSSProperties = {
  padding: "14px 16px",
  borderRadius: 12,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
};
const statLabelStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
};
const statValueStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 16,
  fontWeight: 500,
  color: "var(--ink)",
};
const sectionTitleStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  marginBottom: 8,
};
const imprintStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ink-2)",
  whiteSpace: "pre-wrap",
  fontFamily: "inherit",
  margin: 0,
};
const notMemberStyle: CSSProperties = {
  maxWidth: 600,
  margin: "120px auto",
  padding: 36,
  borderRadius: 14,
  border: "0.5px dashed var(--line-2)",
  color: "var(--ink-2)",
  fontSize: 14,
  lineHeight: 1.55,
  textAlign: "center",
};
