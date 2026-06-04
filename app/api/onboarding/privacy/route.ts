/**
 * POST /api/onboarding/privacy — enable the local PII vault (onboarding).
 *
 * Body: { vault?: boolean, ner?: boolean }
 *
 * Appends LAZYOS_PII_VAULT / LAZYOS_PII_NER to .env.local (append-only; never
 * clobbers) and reflects them into the live process env so the choice takes effect
 * immediately. The NER layer additionally needs a small local Ollama model
 * (LAZYOS_PII_NER_MODEL, default qwen2); we report whether it looks available so
 * the wizard can hint "pull the model" without ever blocking.
 *
 * See docs/privacy.md and docs/compliance.md.
 */

import { NextResponse, type NextRequest } from "next/server";

import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";
import { appendEnvVar } from "@/lib/onboarding/env-writer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  vault?: boolean;
  ner?: boolean;
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
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const applied: string[] = [];
  if (body.vault) {
    appendEnvVar("LAZYOS_PII_VAULT", "true");
    process.env.LAZYOS_PII_VAULT = "true";
    applied.push("LAZYOS_PII_VAULT");
  }
  if (body.ner) {
    appendEnvVar("LAZYOS_PII_NER", "true");
    process.env.LAZYOS_PII_NER = "true";
    applied.push("LAZYOS_PII_NER");
  }

  // The NER layer needs a local Ollama model — best-effort reachability hint.
  const nerModel = process.env.LAZYOS_PII_NER_MODEL?.trim() || "qwen2";
  let nerModelReachable: boolean | null = null;
  if (body.ner) {
    nerModelReachable = false;
    try {
      const url = (
        process.env.LAZYOS_OLLAMA_URL?.trim() || "http://127.0.0.1:11434"
      ).replace(/\/$/, "");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name?: string }> };
        nerModelReachable = (data.models ?? []).some((m) =>
          (m.name ?? "").startsWith(nerModel),
        );
      }
    } catch {
      /* Ollama not reachable → nerModelReachable stays false */
    }
  }

  try {
    writeAudit({
      actor: `user:${user.id}`,
      action: "onboarding.privacy",
      targetUserId: user.id,
      payload: { applied, vault: !!body.vault, ner: !!body.ner, nerModelReachable },
    });
  } catch {
    /* audit is non-fatal */
  }

  return NextResponse.json({
    ok: true,
    applied,
    vaultEnabled: !!body.vault,
    nerEnabled: !!body.ner,
    nerModelReachable,
    note:
      body.ner && nerModelReachable === false
        ? `PII name detection is on, but the local model "${nerModel}" isn't available yet — pull it with \`ollama pull ${nerModel}\`. Deterministic detection (email/IBAN/card/…) works regardless.`
        : null,
  });
}
