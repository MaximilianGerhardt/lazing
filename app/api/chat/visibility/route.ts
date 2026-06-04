/**
 * POST /api/chat/visibility
 *
 * Phase MS · Visibility-Heartbeat. Frontend pingt diesen Endpoint alle 15s
 * mit `{ wsId, visible: boolean }`. Wir tracken pro Workspace den letzten
 * "visible=true"-Zeitstempel; das Push-System unterdrueckt Notifications
 * wenn ein Client innerhalb der TTL als visible gemeldet wurde.
 *
 * Auth: Cookie-basiert (gleicher Pattern wie /api/events/stream).
 *
 * Response: 200 `{ ok: true }`. 401 wenn nicht authentifiziert.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/db/client";
import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "@/lib/security/session";
import { markClientHidden, markClientVisible } from "@/lib/chat/visibility-tracker";
import { ROOT_WORKSPACE_ID } from "@/lib/nav/workspaces-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  wsId: z
    .string()
    .min(1)
    .max(96)
    // Org-Root-Scope `__org_root__:<orgId>` (Phase IA.1) zugelassen — sonst
    // verwirft der `:` die wsId → 400. max(96) deckt den Prefix-Overhead.
    .regex(/^(?:__org_root__:)?[a-z0-9_()][a-z0-9_()-]{0,63}$/i),
  visible: z.boolean(),
});

/**
 * Virtuelle Workspaces, die nicht in der DB-Tabelle stehen — Cross-Workspace-
 * Root-Mode plus die Sessions-Registry-Pseudos. Akzeptiert ohne DB-Lookup.
 */
const VIRTUAL_WORKSPACE_IDS = new Set<string>([
  ROOT_WORKSPACE_ID,
  "(root)",
  "(tmp)",
]);

function workspaceExists(wsId: string): boolean {
  if (VIRTUAL_WORKSPACE_IDS.has(wsId)) return true;
  try {
    const db = getDb();
    const row = db.$raw
      .prepare(`SELECT 1 AS x FROM workspaces WHERE id = ? LIMIT 1`)
      .get(wsId) as { x: number } | undefined;
    return Boolean(row);
  } catch {
    // Bei DB-Fehler konservativ "existiert nicht" — verhindert dass ein
    // DB-Hickser die ganze App pingt-pingt-pingt-loop reduziert.
    return false;
  }
}

export async function POST(req: Request): Promise<Response> {
  const cookieCfg = readSessionConfig();
  if (!cookieCfg) {
    return NextResponse.json(
      { ok: false, error: "auth_not_configured" },
      { status: 503 },
    );
  }
  const cookieValue = readSessionCookie(req.headers.get("cookie"));
  const verified = await verifySessionCookieValue(cookieValue, cookieCfg);
  if (!verified.ok) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json" },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "validation_failed" },
      { status: 400 },
    );
  }

  // P0-2: Workspace-Existenz pruefen. Verhindert Enumeration und
  // schliesst DoS-on-Awareness aus (fremde wsId pingen, um Pushs in
  // unbekannten Workspaces zu unterdruecken).
  if (!workspaceExists(parsed.data.wsId)) {
    return NextResponse.json(
      { ok: false, error: "workspace_not_found" },
      { status: 404 },
    );
  }

  if (parsed.data.visible) {
    markClientVisible(parsed.data.wsId);
  } else {
    markClientHidden(parsed.data.wsId);
  }

  return NextResponse.json({ ok: true });
}
