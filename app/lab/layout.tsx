/**
 * /lab showcase layout (MVP, 2026-05-01).
 *
 * Auth gate (defense-in-depth):
 *   1. Edge middleware sets the subject header
 *   2. This layout reads currentUserIdResolved + redirect /login if null
 *   3. DB lookup: the user MUST have at least one org_membership or
 *      workspace_membership with role IN ('admin','founder')
 *   4. Otherwise: redirect / (home)
 *
 * Roles rationale: the spec document says 'admin/owner'; in the lazyOS
 * schema there is no 'owner' — `founder` is the owner-equivalent
 * role (schema order: guest<viewer<member<admin<founder).
 *
 * The sidebar (260px) lists the 5 MVP kinds. The inspector slot (320px right)
 * is empty in the MVP — wave 3 fills it with a token visualizer.
 */

import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";

import { WorkspaceSwitchRedirect } from "./_components/WorkspaceSwitchRedirect";
import { MVP_KINDS } from "./_lib/kinds-catalog";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["admin", "founder"] as const;

interface MembershipRow {
  role: string;
}

function userHasLabAccess(userId: string): boolean {
  const db = getDb();
  // Org membership check
  const orgRow = db.$raw
    .prepare<unknown[], MembershipRow>(
      `SELECT role FROM org_memberships
        WHERE user_id = ? AND role IN ('admin','founder')
        LIMIT 1`,
    )
    .get(userId);
  if (orgRow) return true;
  // Fallback: workspace membership with an override role
  const wsRow = db.$raw
    .prepare<unknown[], MembershipRow>(
      `SELECT role FROM workspace_memberships
        WHERE user_id = ? AND role IN ('admin','founder')
        LIMIT 1`,
    )
    .get(userId);
  return Boolean(wsRow);
}

export default async function LabLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect("/login?from=%2Flab");
  }
  if (!userHasLabAccess(userId)) {
    redirect("/");
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr",
        minHeight: "100vh",
        background: "var(--sheet)",
        color: "var(--fg, #fff)",
        fontFamily: "var(--font-display)",
      }}
    >
      <WorkspaceSwitchRedirect />
      <aside
        style={{
          borderRight: "1px solid var(--line)",
          padding: "32px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <Link
          href="/lab"
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: "var(--fg, #fff)",
            textDecoration: "none",
            letterSpacing: "-0.01em",
          }}
        >
          /lab
        </Link>
        <p
          style={{
            margin: 0,
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--fg-muted, #999)",
          }}
        >
          Surface-Showcase mit echten Production-Events.
          Privacy-First: high-sensitivity Workspaces ausgefiltert,
          PII redacted.
        </p>
        <nav
          aria-label="Showcase-Surfaces"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--fg-muted, #999)",
              paddingBottom: 8,
            }}
          >
            Surfaces
          </span>
          {MVP_KINDS.map((kind) => (
            <Link
              key={kind.id}
              href={`/lab/${kind.id}`}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 13,
                color: "var(--fg, #ddd)",
                textDecoration: "none",
                lineHeight: 1.4,
              }}
            >
              {kind.label}
            </Link>
          ))}
        </nav>
      </aside>

      <main
        style={{
          padding: "40px 48px",
          maxWidth: 1280,
          width: "100%",
        }}
      >
        {children}
      </main>
    </div>
  );
}
