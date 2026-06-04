/**
 * /api/imagegen/generate
 *
 * POST { workspace, prompt, folder? }
 * Generates an image via the Codex MCP bridge (lib/imagegen/codex-mcp.ts —
 * `codex mcp-server` → built-in `image_gen` tool, no OPENAI_API_KEY),
 * uploads the PNG to the workspace cloud (uploadArtifact, GDPR-/scope-gated)
 * and returns the finished `<surface:document>` markup line, which the
 * caller (e.g. the `/image` slash command) inserts directly as an image bubble
 * into the chat history. The document surface renders `image/png` inline
 * (WhatsApp-style) including tap→fullscreen (PreviewModal).
 *
 * Auth/scope: identical to /api/cloud/generate — sensitivity floor + workspace
 * existence are checked transitively via uploadArtifact() (assertCanWrite).
 *
 * Latency: image gen takes ~50–90 s (gpt-image server-side). Single-flight
 * (N11) in the engine — parallel calls get 429.
 *
 * Local-first: runs ONLY where the `codex` binary + ~/.codex/auth.json
 * exist (the local Next server host). No cloud fallback.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import { startImageJob } from "@/lib/imagegen/job-store";
import { tokenizeStringForExternal } from "@/lib/privacy/protect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard cap on the prompt — prevents abuse / token hogs.
const MAX_PROMPT_CHARS = 2_000;

interface ImagenBody {
  workspace?: string;
  prompt?: string;
}

/**
 * POST { workspace, prompt } → starts the image job in the background and returns
 * IMMEDIATELY { jobId } (no more long request → no proxy timeout). The surface
 * (ImageGenCard) then polls /api/imagegen/status?jobId=… and shows during
 * the ~30–90 s an animated shimmer (like Codex), then the image.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let body: ImagenBody;
  try {
    body = (await req.json()) as ImagenBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const workspace = body.workspace?.trim();
  const prompt = body.prompt?.trim() ?? "";

  if (!workspace) {
    return NextResponse.json({ error: "missing-workspace" }, { status: 400 });
  }
  if (prompt.length === 0) {
    return NextResponse.json({ error: "missing-prompt" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { error: "prompt-too-long", maxChars: MAX_PROMPT_CHARS },
      { status: 413 },
    );
  }

  const actor = resolveActor(req);
  // PII vault: the image prompt goes to the cloud Codex MCP server (gpt-image).
  // Tokenize it first — the cloud must not receive e.g. "a photo of <real name>"
  // or an email/IBAN embedded in the instruction. Output is a PNG, so there is
  // nothing to rehydrate. Pass-through when the vault is off.
  const safePrompt = tokenizeStringForExternal(workspace, prompt);
  const job = startImageJob({ workspace, prompt: safePrompt, actor });
  return NextResponse.json(
    { jobId: job.id, status: job.status },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
