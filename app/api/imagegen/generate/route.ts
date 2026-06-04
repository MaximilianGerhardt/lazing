/**
 * /api/imagegen/generate
 *
 * POST { workspace, prompt, folder? }
 * Erzeugt ein Bild über die Codex-MCP-Brücke (lib/imagegen/codex-mcp.ts —
 * `codex mcp-server` → eingebautes `image_gen`-Tool, kein OPENAI_API_KEY),
 * lädt die PNG in die Workspace-Cloud (uploadArtifact, DSGVO-/Scope-gated)
 * und liefert die fertige `<surface:document>`-Markup-Zeile zurück, die der
 * Caller (z.B. der `/image`-Slash-Command) direkt als Bild-Bubble in den
 * Chat-Verlauf einfügt. Der Document-Surface rendert `image/png` inline
 * (WhatsApp-Stil) inkl. Tap→Vollbild (PreviewModal).
 *
 * Auth/Scope: identisch zu /api/cloud/generate — Sensitivity-Floor + Workspace-
 * Existenz werden transitiv via uploadArtifact() (assertCanWrite) geprüft.
 *
 * Latenz: Bild-Gen dauert ~50–90 s (gpt-image server-seitig). Single-Flight
 * (N11) in der Engine — parallele Aufrufe bekommen 429.
 *
 * Lokal-first: läuft NUR dort, wo das `codex`-Binary + ~/.codex/auth.json
 * existieren (der lokale Next-Server-Host). Kein Cloud-Fallback.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import { startImageJob } from "@/lib/imagegen/job-store";
import { tokenizeStringForExternal } from "@/lib/privacy/protect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard-Cap auf den Prompt — verhindert Missbrauch / Token-Hogs.
const MAX_PROMPT_CHARS = 2_000;

interface ImagenBody {
  workspace?: string;
  prompt?: string;
}

/**
 * POST { workspace, prompt } → startet den Bild-Job im Hintergrund und liefert
 * SOFORT { jobId } (kein Long-Request mehr → kein Proxy-Timeout). Das Surface
 * (ImageGenCard) pollt danach /api/imagegen/status?jobId=… und zeigt während
 * der ~30–90 s einen animierten Shimmer (wie Codex), dann das Bild.
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
