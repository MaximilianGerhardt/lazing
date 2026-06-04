/**
 * POST /api/github/disconnect — drop the GitHub connection for the user.
 *
 * Does NOT delete workspace_github_repos rows by default — the bindings
 * stay (greyed out in UI), so re-connecting later restores everything.
 * Pass { purgeRepos: true } in the body to also drop the bindings.
 */

import { NextResponse, type NextRequest } from "next/server";

import { deleteCredential } from "@/lib/github/repo";
import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DisconnectBody {
  purgeRepos?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: DisconnectBody = {};
  try {
    if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
      body = (await req.json()) as DisconnectBody;
    }
  } catch {
    // empty body is fine.
  }

  const purgeRepos = body.purgeRepos === true;
  const removed = deleteCredential(userId);

  let purgedRepos = 0;
  if (purgeRepos) {
    const db = getDb();
    const res = db.$raw
      .prepare("DELETE FROM workspace_github_repos WHERE user_id = ?")
      .run(userId);
    purgedRepos = res.changes;
  }

  return NextResponse.json({
    disconnected: removed,
    purgedRepos,
  });
}
