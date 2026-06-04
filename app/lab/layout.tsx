/**
 * /lab Showcase-Layout (MVP, 2026-05-01).
 *
 * Auth-Gate (Defense-in-Depth):
 *   1. Edge-Middleware setzt subject-Header
 *   2. Dieses Layout liest currentUserIdResolved + redirect /login wenn null
 *   3. DB-Lookup: User MUSS mindestens eine org_membership oder
 *      workspace_membership mit role IN ('admin','founder') haben
 *   4. Sonst: redirect / (Home)
 *
 * Begründung Roles: das spec-Dokument sagt 'admin/owner'; im lazyOS-
 * Schema gibt es 'owner' nicht — `founder` ist die owner-äquivalente
 * Rolle (Schema-Reihenfolge: guest<viewer<member<admin<founder).
 *
 * Sidebar (260px) listet die 5 MVP-Kinds. Inspector-Slot (320px rechts)
 * ist im MVP leer — Welle 3 füllt ihn mit Token-Visualizer.
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
  // Org-Membership-Check
  const orgRow = db.$raw
    .prepare<unknown[], MembershipRow>(
      `SELECT role FROM org_memberships
        WHERE user_id = ? AND role IN ('admin','founder')
        LIMIT 1`,
    )
    .get(userId);
  if (orgRow) return true;
  // Fallback: Workspace-Membership mit Override-Rolle
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
