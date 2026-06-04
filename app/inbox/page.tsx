/**
 * /inbox — Phase IB action-required view.
 *
 * Server component. Reads current-user, aggregates pending items via
 * `lib/inbox/aggregate.ts`. Apple keynote style, sorted by priority.
 */

import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import Link from "next/link";
import type { CSSProperties } from "react";

import { aggregateInbox, type InboxItem, type InboxItemKind } from "@/lib/inbox/aggregate";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findActiveUserById } from "@/lib/users/repo";
import { listOrgsForUser } from "@/lib/orgs/repo";
import { getServerT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<InboxItemKind, string> = {
  "ticket-review": "Review",
  "ticket-approved-pending": "Dispatch",
  "workstream-stale": "Stale",
};

const KIND_COLOR: Record<InboxItemKind, string> = {
  "ticket-review": "var(--a-now)",
  "ticket-approved-pending": "var(--a-clientb)",
  "workstream-stale": "var(--ink-3)",
};

export default async function InboxPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?reason=inbox-needs-login");
  }
  const user = findActiveUserById(userId);
  if (!user) {
    redirect("/login");
  }

  // Phase IA.5 — org-filtered inbox. Cookie `lazyos.org` (set by the
  // OrgSwitcher) decides which org is currently active. Fallback: the user's
  // first available org.
  const c = await cookies();
  const cookieOrgId = c.get("lazyos.org")?.value ?? c.get("lazyos_org")?.value ?? null;
  let activeOrgId: string | undefined;
  if (cookieOrgId && cookieOrgId !== "__all__") {
    activeOrgId = cookieOrgId;
  } else {
    const myOrgs = listOrgsForUser(userId);
    activeOrgId = myOrgs[0]?.id;
  }

  const { items, counts, total } = await aggregateInbox(userId, {
    orgId: activeOrgId,
  });
  const tt = await getServerT();

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <header style={heroStyle}>
        <div style={crumbStyle}>{tt("inbox.crumb")}</div>
        <h1 style={titleStyle}>
          {total === 0
            ? tt("inbox.title.empty")
            : tt("inbox.title.has", { count: total, plural: total === 1 ? "" : "s" })}
        </h1>
        {total === 0 ? (
          <p style={leadStyle}>{tt("inbox.empty.body")}</p>
        ) : (
          <p style={leadStyle}>{tt("inbox.lead")}</p>
        )}
        {total > 0 ? (
          <div style={countsRowStyle}>
            {(Object.keys(counts) as InboxItemKind[]).map((k) => (
              <span
                key={k}
                style={{
                  ...countPillStyle,
                  borderColor: KIND_COLOR[k],
                  color: counts[k] > 0 ? KIND_COLOR[k] : "var(--ink-3)",
                }}
              >
                {KIND_LABEL[k]} · {counts[k]}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      {total > 0 ? (
        <section style={listWrapStyle}>
          {items.map((it) => (
            <InboxRow key={`${it.kind}-${it.id}`} item={it} />
          ))}
        </section>
      ) : null}
    </main>
  );
}

function InboxRow({ item }: { item: InboxItem }): React.JSX.Element {
  const ago = formatAgo(item.updatedAt);
  return (
    <Link href={item.href} style={rowStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={rowTopStyle}>
          <span
            style={{
              ...badgeStyle,
              borderColor: KIND_COLOR[item.kind],
              color: KIND_COLOR[item.kind],
            }}
          >
            {KIND_LABEL[item.kind]}
          </span>
          <span style={wsLabelStyle}>{item.workspaceLabel}</span>
        </div>
        <div style={rowTitleStyle}>{item.title}</div>
        {item.meta ? <div style={rowMetaStyle}>{item.meta}</div> : null}
      </div>
      <div style={rowAgoStyle}>{ago}</div>
    </Link>
  );
}

function formatAgo(ts: number): string {
  const ms = Date.now() - ts;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "gerade";
  if (min < 60) return `vor ${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h}h`;
  const d = Math.round(h / 24);
  return `vor ${d}d`;
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
  marginTop: 14,
  fontSize: "clamp(34px, 5vw, 60px)",
  letterSpacing: "-0.035em",
  lineHeight: 1.04,
};

const leadStyle: CSSProperties = {
  marginTop: 12,
  maxWidth: 720,
  fontSize: "clamp(15px, 1.7vw, 18px)",
  lineHeight: 1.55,
  color: "var(--ink-2)",
};

const countsRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  marginTop: 24,
  flexWrap: "wrap",
};

const countPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 12px",
  borderRadius: 999,
  border: "0.5px solid var(--line-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const listWrapStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: "clamp(40px, 6vw, 72px)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  padding: "16px 20px",
  borderRadius: 14,
  border: "0.5px solid var(--line-2)",
  background: "color-mix(in oklab, var(--sheet-2) 80%, transparent)",
  textDecoration: "none",
  color: "inherit",
};

const rowTopStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

const badgeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  padding: "2px 8px",
  borderRadius: 999,
  border: "0.5px solid",
};

const wsLabelStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--ink-3)",
};

const rowTitleStyle: CSSProperties = {
  fontSize: 15,
  color: "var(--ink)",
  letterSpacing: "-0.005em",
  marginTop: 2,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};

const rowMetaStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--ink-3)",
  lineHeight: 1.5,
};

const rowAgoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--ink-3)",
  whiteSpace: "nowrap",
  flexShrink: 0,
};
