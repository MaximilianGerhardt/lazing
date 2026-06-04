/**
 * GET  /api/orgs              — list all orgs current user is member of
 * POST /api/orgs { id, name, type? } — create new org + auto-add current user as founder
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { writeAudit } from "@/lib/audit/write";
import { getDb } from "@/db/client";
import {
  ORGANIZATION_TYPES,
  organizations,
  type OrganizationType,
} from "@/db/schema/organizations";
import { orgMemberships } from "@/db/schema/memberships";
import { listOrgsForUser, listTopLevelOrgsForUser } from "@/lib/orgs/repo";
import { currentActor } from "@/lib/security/subject";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { ulid } from "@/lib/ulid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: "auth-required", hint: "Bitte einloggen." },
      { status: 401 },
    );
  }
  // Phase IA consolidation 2026-04-29: default = top-level orgs only,
  // so the TopNav switcher does not list 10 sub-orgs. Whoever needs sub-orgs
  // asks with ?include=all.
  const url = new URL(req.url);
  const includeAll = url.searchParams.get("include") === "all";
  const orgs = includeAll ? listOrgsForUser(userId) : listTopLevelOrgsForUser(userId);
  return NextResponse.json({
    orgs: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type,
      parentId: o.parentId,
      logoUrl: o.logoUrl,
      brandColors: o.brandColors,
      paletteIndex: o.paletteIndex,
      archived: o.archived,
      responsibleUserId: o.responsibleUserId,
    })),
  });
}

interface CreateOrgBody {
  id?: string;
  name?: string;
  type?: string;
  description?: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ "ä": "ae", "ö": "oe", "ü": "ue" })[c] ?? c)
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: "auth-required", hint: "Bitte einloggen." },
      { status: 401 },
    );
  }

  let body: CreateOrgBody;
  try {
    body = (await req.json()) as CreateOrgBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name || name.length < 2) {
    return NextResponse.json(
      { error: "missing-name", hint: "Name ist Pflicht (≥2 Zeichen)" },
      { status: 400 },
    );
  }

  const id = body.id?.trim().toLowerCase() || slugify(name);
  if (!SLUG_RE.test(id)) {
    return NextResponse.json(
      { error: "invalid-id", hint: "id muss [a-z0-9-] sein, 2-63 Zeichen" },
      { status: 400 },
    );
  }

  const type: OrganizationType =
    body.type && (ORGANIZATION_TYPES as readonly string[]).includes(body.type)
      ? (body.type as OrganizationType)
      : "client";

  const db = getDb();
  // Conflict check
  const existing = db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1)
    .all();
  if (existing.length > 0) {
    return NextResponse.json(
      { error: "id-taken", message: `Org-id "${id}" existiert bereits` },
      { status: 409 },
    );
  }

  const now = new Date();
  db.insert(organizations)
    .values({
      id,
      name,
      type,
      parentId: null,
      paletteIndex: 0,
      description: body.description ?? null,
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Auto-membership: creating user as founder.
  db.insert(orgMemberships)
    .values({
      id: `om_${ulid()}`,
      userId,
      orgId: id,
      role: "founder",
      invitedByUserId: null,
      joinedAt: now,
      updatedAt: now,
    })
    .run();

  // Set owner.
  db.$raw
    .prepare(
      "UPDATE organizations SET responsible_user_id = ?, updated_at = ? WHERE id = ?",
    )
    .run(userId, now.getTime(), id);

  // Phase IA.4 — for each new org create an org-root pseudo-workspace
  // directly, so the org switcher immediately has a scoped chat.
  const rootWsId = `__org_root__:${id}`;
  db.$raw
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        id, label, accent, path, sensitivity, archived,
        description, organization_id, created_at, updated_at
      ) VALUES (?, ?, ?, '', 'normal', 0, ?, ?, ?, ?)`,
    )
    .run(
      rootWsId,
      `${name} · Root`,
      'a-now',
      'Org-Root-Chat — alles was hier passiert ist scoped auf die Org-Rechte-Ebene.',
      id,
      now.getTime(),
      now.getTime(),
    );

  writeAudit({
    actor: currentActor(req),
    action: "org.created",
    orgId: id,
    targetUserId: userId,
    payload: { name, type },
  });

  return NextResponse.json(
    {
      org: {
        id,
        name,
        type,
        description: body.description ?? null,
        responsibleUserId: userId,
      },
    },
    { status: 201 },
  );
}
