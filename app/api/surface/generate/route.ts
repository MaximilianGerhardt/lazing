/**
 * POST /api/surface/generate — Magic-Wand Surface-Helper (STUB · 2026-05-30).
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║    STUB — NOT THE FULL GENERATIVE BUILD.                            ║
 * ║                                                                      ║
 * ║  This route fulfils the *contract* of the Magic-Wand trigger hook    ║
 * ║  (Agent D's UI calls it) and is fail-soft + fully scope/auth-gated,  ║
 * ║  but it does NOT yet run the Opus-4.8 generation nor does it know    ║
 * ║  about the `panel` SurfaceKind (that kind ships in Slice 5 of        ║
 * ║  docs/plans/2026-05-30_apple-ux-surface-rework.md). Until Slice 5    ║
 * ║  lands, this endpoint returns a deterministic, N6-shaped *fallback*  ║
 * ║  panel built from the raw input — no LLM call, no hallucinated HTML, ║
 * ║  no inline hex. It proves the wire end-to-end so D can build the UI  ║
 * ║  affordance against a real, stable response shape.                   ║
 * ║                                                                      ║
 * ║  The full path (Opus generation + closed-allowlist block validator  ║
 * ║  + renderPanel) is planned as a subplan in the doc above.            ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Request body:
 *   {
 *     workspaceId: string;          // N9 scope anchor (required, auth-gated)
 *     rawSurfaceText: string;       // the offending <surface:…> blob OR free text
 *     failedKind?: string | null;   // the kind the renderer could not handle
 *     reason?: 'unknown-kind' | 'parse-fail' | 'render-null' | 'user-request';
 *     intent?: string | null;       // optional owner hint ("zeig mir das als Liste")
 *   }
 *
 * Response (200):
 *   {
 *     ok: true;
 *     stub: true;                   // ← honest flag: this is the fallback path
 *     surface: { kind: 'panel'; data: PanelData };   // N6-validated panel
 *   }
 * Response (422) when the input can't be salvaged into a panel:
 *   { ok: false; stub: true; error: 'ungeneratable'; message: string }
 *
 * Auth: member of the workspace (canEditWorkspaceContent), same as the
 * other surface-action routes in this codebase.
 *
 * SECURITY / N6: the response NEVER contains raw HTML, inline styles, or hex
 * colours. Every block is one of the closed-allowlist primitives and is run
 * through `validatePanel` (fail-closed) before it leaves this handler. No
 * secret is read or returned.
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// N6 closed-allowlist panel contract (LOCAL STUB COPY).
//
// In the Slice-5 build this type + the validator move to a shared module
// (e.g. lib/chat/panel.ts) that BOTH this route and renderPanel import, so
// there is exactly one source of truth for the allowlist. The stub keeps a
// local, intentionally minimal copy so it can ship without touching
// lib/chat/* (owned by Agents A/D).
// ---------------------------------------------------------------------------

/** The closed allowlist of panel block primitives (N6). */
const PANEL_BLOCK_KINDS = [
  "text",
  "kv-list",
  "stepper",
  "collapsible",
  "rows",
  "graph",
  "diff",
  "action-bar",
] as const;
type PanelBlockKind = (typeof PANEL_BLOCK_KINDS)[number];

interface PanelData {
  title?: string;
  blocks: Array<{ kind: PanelBlockKind; [k: string]: unknown }>;
}

function isPanelBlockKind(s: unknown): s is PanelBlockKind {
  return (
    typeof s === "string" &&
    (PANEL_BLOCK_KINDS as readonly string[]).includes(s)
  );
}

/**
 * Fail-closed validator. Rejects anything that is not a panel of
 * allowlisted blocks. Strips nothing silently — an invalid block makes the
 * whole panel invalid (returns null). The full Slice-5 validator additionally
 * checks token-only colour fields and per-primitive shape.
 */
function validatePanel(v: unknown): PanelData | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.blocks) || obj.blocks.length === 0) return null;
  for (const b of obj.blocks) {
    if (typeof b !== "object" || b === null) return null;
    if (!isPanelBlockKind((b as Record<string, unknown>).kind)) return null;
  }
  const title =
    typeof obj.title === "string" ? obj.title : undefined;
  return {
    title,
    blocks: obj.blocks as PanelData["blocks"],
  };
}

// ---------------------------------------------------------------------------
// Request validation (mirrors the idioms in live-warn-ack/route.ts).
// ---------------------------------------------------------------------------

function isValidWorkspaceId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

interface GenerateBody {
  workspaceId: string;
  rawSurfaceText: string;
  failedKind?: string | null;
  reason?: string | null;
  intent?: string | null;
}

function parseBody(v: unknown): GenerateBody | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isValidWorkspaceId(o.workspaceId)) return null;
  if (typeof o.rawSurfaceText !== "string") return null;
  return {
    workspaceId: o.workspaceId,
    rawSurfaceText: o.rawSurfaceText,
    failedKind:
      typeof o.failedKind === "string" ? o.failedKind : null,
    reason: typeof o.reason === "string" ? o.reason : null,
    intent: typeof o.intent === "string" ? o.intent : null,
  };
}

// ---------------------------------------------------------------------------
// STUB generator: deterministic fallback panel from the raw input.
//
// No LLM, no I/O. Takes the offending text and wraps it in a single `text`
// block plus a kv-list of the failure metadata, so the owner at least sees
// the content that failed to render — inside a valid panel. The real Opus
// generation replaces THIS function in Slice 5 (see plan doc). The validator
// gate stays in place regardless, so even the real path can't emit
// non-allowlisted blocks.
// ---------------------------------------------------------------------------

function buildFallbackPanel(body: GenerateBody): PanelData {
  // Keep the FULL raw text (N1: no .slice/.substring truncation of content).
  const meta: Array<{ k: string; v: string }> = [];
  if (body.failedKind) meta.push({ k: "kind", v: body.failedKind });
  if (body.reason) meta.push({ k: "grund", v: body.reason });
  if (body.intent) meta.push({ k: "wunsch", v: body.intent });

  const blocks: PanelData["blocks"] = [
    {
      kind: "text",
      text: body.rawSurfaceText,
      tone: "mono",
    },
  ];
  if (meta.length > 0) {
    blocks.push({ kind: "kv-list", items: meta });
  }

  return {
    title: "Surface konnte nicht gerendert werden",
    blocks,
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json(
      {
        error: "invalid_body",
        message:
          "expected { workspaceId, rawSurfaceText, failedKind?, reason?, intent? }",
      },
      { status: 400 },
    );
  }

  // N9 scope gate — owner must be allowed to edit this workspace's content.
  if (
    !canEditWorkspaceContent(
      getEffectiveWorkspaceRole(userId, body.workspaceId),
    )
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // ─── STUB generation path (no LLM yet) ───────────────────────────────────
  const candidate = buildFallbackPanel(body);

  // N6 fail-closed: even the deterministic fallback must pass the validator.
  const panel = validatePanel(candidate);
  if (!panel) {
    return NextResponse.json(
      {
        ok: false,
        stub: true,
        error: "ungeneratable",
        message:
          "stub could not produce a valid panel from the given input",
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    ok: true,
    stub: true,
    surface: { kind: "panel" as const, data: panel },
  });
}
