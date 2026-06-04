/**
 * DELETE /api/cloud/share/[tokenId] — revoke share-token (auth-required).
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { writeAudit } from "@/lib/audit/write";
import { getDb } from "@/db/client";
import { shareTokens } from "@/db/schema/share_tokens";
import { revokeShareToken } from "@/lib/cloud/share";
import { currentActor, currentUserId } from "@/lib/security/subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ tokenId: string }> },
): Promise<Response> {
  const { tokenId } = await params;
  const userId = currentUserId(req);
  if (!userId || userId === "max-bootstrap") {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  const db = getDb();
  const rows = db
    .select()
    .from(shareTokens)
    .where(eq(shareTokens.id, tokenId))
    .limit(1)
    .all();
  const token = rows[0];
  if (!token) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  // Caller muss derselbe User sein der issued, ODER Workspace-Member mit
  // admin/founder. Day-1 reicht „derselbe User oder Owner". Phase-N: full
  // membership-role-check.
  if (token.createdByUserId !== userId) {
    return NextResponse.json(
      { error: "forbidden", message: "Nur der Aussteller darf revoken." },
      { status: 403 },
    );
  }
  revokeShareToken(tokenId, userId);
  writeAudit({
    actor: currentActor(req),
    action: "magic.expired",
    workspaceId: token.workspaceId,
    artifactId: token.artifactId,
    payload: { kind: "share-revoked", tokenId },
  });
  return NextResponse.json({ ok: true });
}
