/**
 * GET /api/state/projection/[workspaceId]
 *
 * Phase 1 Track E (2026-05-29) — State-Projection-Spine.
 *
 * Liefert den deterministischen operativen Zustand eines Workspace aus der
 * DB/Event-Truth. Gegenstück zu Befund D Handoff §10: „Es braucht eine
 * State Projection aus DB/Event-State […]; sichtbare historische
 * Chat-Surfaces dürfen nicht die Quelle der Wahrheit sein."
 *
 * Output-Vertrag: lib/projection/types.ts → WorkspaceState (siehe dort
 * für vollständige Doku — was die Felder bedeuten, was nicht).
 *
 * ── Auth-Gate ────────────────────────────────────────────────────────────
 *   Identisch zu /api/permission/[workspaceId]/mode (s. permissions.ts):
 *   (A) currentUserIdResolved        → 401 wenn nicht eingeloggt.
 *   (B) canEditWorkspaceContent      → 403 wenn < member.
 *   (C) hasRealWorkspaceMembership   → 403 (IDOR-Härtung, kein
 *       solo-implicit-founder-Vertrauen für sensible operative State-Reads).
 *
 * ── Cache-Disziplin ──────────────────────────────────────────────────────
 *   Cache-Control: no-store, must-revalidate.
 *   Die Projektion ist per Definition zeit-sensitiv (z.B. ein eben
 *   beantworteter Question-Eintrag muss SOFORT als answered=true zurückkommen).
 *   force-dynamic erzwingt das auch in Vercel-Edge-Cache-Strategien.
 *
 * ── Latenz-Budget ────────────────────────────────────────────────────────
 *   <100ms für realistische Workspace-Last. Performance-Smoke im Test prüft
 *   die Funktion direkt; die Route addiert nur Auth + JSON-Serialisierung.
 *
 * ── Read-Only ────────────────────────────────────────────────────────────
 *   Diese Route schreibt NIE. Kein Audit-Row, kein State-Mutation. Pure
 *   read-only Projektion.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { projectWorkspaceState } from '@/lib/projection/state-projector';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ workspaceId: string }>;
}

// Konservativer Format-Guard auf workspaceId (gespiegelt aus
// /api/permission/[workspaceId]/mode + /api/connectors/invoke). Verhindert
// dass Kontroll-/überlange Werte in DB-Queries oder Logs landen.
const WORKSPACE_ID_RE = /^(?:__org_root__:)?[a-zA-Z0-9_:()-]{1,128}$/;

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;

  // ── 1. Format-Guard ──────────────────────────────────────────────────────
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── 2. Auth-Gate ─────────────────────────────────────────────────────────
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'auth-required' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── 3. Projektion ────────────────────────────────────────────────────────
  // projectWorkspaceState ist intern fail-soft — wirft niemals. Wir wrappen
  // dennoch defensiv (Defense-in-Depth), damit ein unerwarteter DB-Fehler
  // (z.B. korruptes Schema) nicht den Route-Handler crashen lässt.
  try {
    const db = getDb();
    const state = projectWorkspaceState(db.$raw, workspaceId);
    return NextResponse.json(state, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, must-revalidate',
      },
    });
  } catch (err) {
    console.error('[state/projection GET] unexpected error:', err);
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
