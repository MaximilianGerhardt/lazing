/**
 * GET/POST /api/governance/consent — Phase 2 W2.1 · Lane G Governance.
 *
 * Master-Briefing §13.2 (verbatim, N1):
 *   „Opt-in · Transparenz · Zweckbindung · Datenminimierung · Pause/Stop
 *    jederzeit · Redaction · keine geheimen Screenshots · keine Passwörter ·
 *    keine privaten Daten · Review durch betroffene Person · Betriebsrat/
 *    Arbeitsrecht beachten"
 *
 * GET  /api/governance/consent?workspaceId=...&userId=...&dataSource=...&onlyActive=1
 *   → { rows: ConsentGrant[] }
 *
 * POST /api/governance/consent
 *   body: { op: 'grant', workspaceId, userId, dataSource, level, reasonText, scope? }
 *      → { ok: true, grant: ConsentGrant }
 *   body: { op: 'revoke', workspaceId, userId, dataSource, grantId? }
 *      → { ok: true, grant: ConsentGrant } | { ok: false, error: 'not-found' }
 *
 * Subject-Gate: requireSession (currentUserIdResolved). 401 ohne Session.
 *
 * Side-Effects:
 *   - POST grant erzeugt eine consent_grants-Row UND einen governance_audit-
 *     Eintrag (decision='allowed', reason verbatim).
 *   - POST revoke setzt revoked_at + erzeugt einen governance_audit-
 *     Eintrag (decision='allowed', reason erklärt §13.2 „Pause/Stop").
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  grantConsent,
  listConsents,
  revokeConsent,
  type ConsentLevel,
  type ConsentScope,
  type GrantConsentInput,
} from "@/lib/governance/consent";
import { writeGovernanceAudit } from "@/lib/governance/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_LEVELS: ReadonlySet<ConsentLevel> = new Set([
  "none",
  "read-only",
  "read-derive",
  "read-derive-act",
  "full-automation",
]);

function rawDb(): import("better-sqlite3").Database {
  return getDb().$raw as unknown as import("better-sqlite3").Database;
}

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: "auth-required", hint: "Bitte einloggen." },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  if (!workspaceId) {
    return NextResponse.json(
      { error: "invalid-query", hint: "workspaceId required" },
      { status: 400 },
    );
  }
  const targetUserId = url.searchParams.get("userId") ?? undefined;
  const dataSource = url.searchParams.get("dataSource") ?? undefined;
  const onlyActiveParam = url.searchParams.get("onlyActive");
  const onlyActive = onlyActiveParam === "1" || onlyActiveParam === "true";
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  const rows = listConsents(rawDb(), workspaceId, {
    userId: targetUserId,
    dataSource,
    onlyActive,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  return NextResponse.json({ rows });
}

interface GrantBody {
  op: "grant";
  workspaceId: string;
  userId: string;
  dataSource: string;
  level: ConsentLevel;
  reasonText: string;
  scope?: ConsentScope | null;
}

interface RevokeBody {
  op: "revoke";
  workspaceId: string;
  userId: string;
  dataSource: string;
  grantId?: string;
}

type PostBody = GrantBody | RevokeBody;

export async function POST(req: NextRequest): Promise<Response> {
  const sessionUserId = currentUserIdResolved(req);
  if (!sessionUserId) {
    return NextResponse.json(
      { error: "auth-required", hint: "Bitte einloggen." },
      { status: 401 },
    );
  }

  let body: PostBody | undefined;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || typeof body.op !== "string") {
    return NextResponse.json(
      { error: "invalid-body", hint: "op required (grant|revoke)" },
      { status: 400 },
    );
  }
  if (
    typeof body.workspaceId !== "string" ||
    body.workspaceId.length === 0 ||
    typeof body.userId !== "string" ||
    body.userId.length === 0 ||
    typeof body.dataSource !== "string" ||
    body.dataSource.length === 0
  ) {
    return NextResponse.json(
      {
        error: "invalid-body",
        hint: "workspaceId + userId + dataSource required",
      },
      { status: 400 },
    );
  }

  const raw = rawDb();

  if (body.op === "grant") {
    const grantBody = body as GrantBody;
    if (!VALID_LEVELS.has(grantBody.level)) {
      return NextResponse.json(
        {
          error: "invalid-body",
          hint: `level must be one of ${[...VALID_LEVELS].join("|")}`,
        },
        { status: 400 },
      );
    }
    if (
      typeof grantBody.reasonText !== "string" ||
      grantBody.reasonText.length === 0
    ) {
      return NextResponse.json(
        {
          error: "invalid-body",
          hint: "reasonText required (§13.2 verbatim Begründung, N1)",
        },
        { status: 400 },
      );
    }

    const input: GrantConsentInput = {
      workspaceId: grantBody.workspaceId,
      userId: grantBody.userId,
      dataSource: grantBody.dataSource,
      level: grantBody.level,
      scope: grantBody.scope ?? null,
      reasonText: grantBody.reasonText, // N1: verbatim
    };

    try {
      const grant = grantConsent(raw, input);
      writeGovernanceAudit(raw, {
        workspaceId: grantBody.workspaceId,
        userId: sessionUserId,
        action: "persist-belief", // grant ist eine workspace-interne Persistierung
        dataSource: grantBody.dataSource,
        decision: "allowed",
        reason:
          `Consent-Grant für dataSource '${grantBody.dataSource}' auf Level ` +
          `'${grantBody.level}' für userId '${grantBody.userId}' angelegt ` +
          `(§13.2 Opt-in). Begründung: ${grantBody.reasonText}`,
      });
      return NextResponse.json({ ok: true, grant });
    } catch (err) {
      return NextResponse.json(
        {
          error: "grant-failed",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 400 },
      );
    }
  }

  if (body.op === "revoke") {
    const revokeBody = body as RevokeBody;
    try {
      const grant = revokeConsent(raw, {
        workspaceId: revokeBody.workspaceId,
        userId: revokeBody.userId,
        dataSource: revokeBody.dataSource,
        grantId: revokeBody.grantId,
      });
      if (!grant) {
        return NextResponse.json(
          { ok: false, error: "not-found" },
          { status: 404 },
        );
      }
      writeGovernanceAudit(raw, {
        workspaceId: revokeBody.workspaceId,
        userId: sessionUserId,
        action: "persist-belief",
        dataSource: revokeBody.dataSource,
        decision: "allowed",
        reason:
          `Consent-Revoke für dataSource '${revokeBody.dataSource}' und userId ` +
          `'${revokeBody.userId}' (§13.2 „Pause/Stop jederzeit"). Grant '${grant.id}' ` +
          `wurde mit revoked_at=${grant.revokedAt} markiert.`,
      });
      return NextResponse.json({ ok: true, grant });
    } catch (err) {
      return NextResponse.json(
        {
          error: "revoke-failed",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 400 },
      );
    }
  }

  return NextResponse.json(
    { error: "invalid-body", hint: "op must be 'grant' or 'revoke'" },
    { status: 400 },
  );
}
