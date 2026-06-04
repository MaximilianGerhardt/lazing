/**
 * /api/cloud/[id]/share
 *   GET  — list active share-tokens for this artifact (auth-required)
 *   POST — issue new share-token { expiresInHours, maxViews?, password? }
 */

import { NextResponse, type NextRequest } from "next/server";

import { writeAudit } from "@/lib/audit/write";
import {
  getArtifact,
  CloudError,
} from "@/lib/cloud/service";
import {
  issueShareToken,
  listSharesForArtifact,
  ShareError,
} from "@/lib/cloud/share";
import { currentActor, currentUserId } from "@/lib/security/subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ShareIssueBody {
  expiresInHours?: number;
  maxViews?: number | null;
  password?: string | null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const userId = currentUserId(req);
  if (!userId || userId === "max-bootstrap") {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  // Verify the user has read on the artifact (uses sensitivity-floor).
  try {
    await getArtifact(id, currentActor(req));
  } catch (err) {
    if (err instanceof CloudError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.code === "artifact-not-found" ? 404 : 403 },
      );
    }
    throw err;
  }
  const shares = listSharesForArtifact(id);
  return NextResponse.json({
    shares: shares.map((s) => ({
      id: s.id,
      expiresAt:
        s.expiresAt instanceof Date ? s.expiresAt.toISOString() : s.expiresAt,
      maxViews: s.maxViews,
      currentViews: s.currentViews,
      hasPassword: !!s.passwordHash,
      createdAt:
        s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
      lastViewedAt:
        s.lastViewedAt instanceof Date
          ? s.lastViewedAt.toISOString()
          : s.lastViewedAt,
    })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const userId = currentUserId(req);
  if (!userId || userId === "max-bootstrap") {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: ShareIssueBody;
  try {
    body = (await req.json()) as ShareIssueBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  let artifact;
  try {
    artifact = await getArtifact(id, currentActor(req));
  } catch (err) {
    if (err instanceof CloudError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.code === "artifact-not-found" ? 404 : 403 },
      );
    }
    throw err;
  }

  const expiresInHours =
    typeof body.expiresInHours === "number" && body.expiresInHours > 0
      ? Math.min(body.expiresInHours, 24 * 30) // Cap 30 Tage
      : 24; // default 24h
  const maxViews =
    typeof body.maxViews === "number" && body.maxViews > 0
      ? Math.min(body.maxViews, 10000)
      : null;
  const password = body.password?.trim() || null;

  let issued;
  try {
    issued = issueShareToken({
      artifactId: id,
      workspaceId: artifact.workspaceId,
      expiresInHours,
      maxViews,
      password,
      createdByUserId: userId,
    });
  } catch (err) {
    if (err instanceof ShareError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: 400 },
      );
    }
    throw err;
  }

  const origin = req.nextUrl.origin;
  const shareUrl = `${origin}/share/${encodeURIComponent(issued.rawToken)}`;

  writeAudit({
    actor: currentActor(req),
    action: "magic.issued", // re-use generic auth-issue action
    workspaceId: artifact.workspaceId,
    artifactId: id,
    payload: {
      kind: "share-token",
      tokenId: issued.tokenId,
      expiresInHours,
      maxViews,
      hasPassword: !!password,
    },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json(
    {
      shareUrl,
      tokenId: issued.tokenId,
      expiresAt:
        issued.expiresAt instanceof Date
          ? issued.expiresAt.toISOString()
          : issued.expiresAt,
    },
    { status: 201 },
  );
}
