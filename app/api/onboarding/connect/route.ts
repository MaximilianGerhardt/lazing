/**
 * POST /api/onboarding/connect  — robust engine connect, paste-key path (B3)
 *
 * Body: { engine: "codex" | "claude", apiKey: string }
 *
 * Writes the matching provider key (OPENAI_API_KEY for codex,
 * ANTHROPIC_API_KEY for claude) to .env.local via the append-only env writer
 * (never clobbers), reflects it into the live process env, clears the engine
 * selector cache, and re-probes so the wizard can immediately show green.
 *
 * The two robust paths are EQUAL: (A) terminal OAuth (`claude login` /
 * `codex login`, verified by polling /api/engine/detect?fresh=1) and (B) this
 * paste path. Claude credentials-JSON reuses POST /api/users/me/claude-creds,
 * so it is intentionally NOT duplicated here.
 *
 * The raw key never leaves the server and is never echoed in the response.
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";
import { clearEngineCache, detectEngines } from "@/lib/llm/engines/selector";
import { appendEnvVar, type WritableEnvKey } from "@/lib/onboarding/env-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PasteEngine = "codex" | "claude";

const ENGINE_TO_ENV: Record<PasteEngine, WritableEnvKey> = {
  codex: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
};

interface PostBody {
  engine?: string;
  apiKey?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const engine = body.engine;
  if (engine !== "codex" && engine !== "claude") {
    return NextResponse.json({ error: "invalid-engine" }, { status: 400 });
  }
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length < 8) {
    return NextResponse.json({ error: "invalid-key" }, { status: 400 });
  }

  const envKey = ENGINE_TO_ENV[engine];
  let outcome: "appended" | "exists";
  try {
    const result = appendEnvVar(envKey, apiKey);
    outcome = result.outcome;
  } catch (err) {
    return NextResponse.json(
      { error: "env-write-failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // The new key may unlock a previously-unavailable engine — refresh the probe.
  clearEngineCache();
  const selection = await detectEngines({ forceProbe: true });
  const engineId = engine === "codex" ? "codex-cli" : "claude-cli";
  const available = selection.available.some((a) => a.engine === engineId && a.available);

  writeAudit({
    actor: `user:${user.id}`,
    action: "onboarding.connect.paste-key",
    targetUserId: user.id,
    // Never log the key itself — only which env key + outcome.
    payload: { engine, envKey, outcome, available },
  });

  return NextResponse.json({
    ok: true,
    engine,
    envKey,
    outcome,
    available,
    hint: outcome === "exists"
      ? "A value for this key already existed in .env.local — left untouched. Edit it manually to change it."
      : "Key appended to .env.local. Restart the server if the engine is still not picked up.",
  });
}
