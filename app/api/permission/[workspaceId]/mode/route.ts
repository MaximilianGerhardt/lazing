/**
 * GET+PATCH /api/permission/[workspaceId]/mode — Permission Mode Setup (A1, 2026-05-25).
 *
 * GET:   Returns the current permission mode for the workspace.
 * PATCH: Sets (upserts) the permission mode. Body: { mode: 'freerein'|'lane'|'ask' }
 *        (plus 'freerein-with-audit' for advanced callers).
 *
 * Auth gate (identical to credential route):
 *   1. currentUserIdResolved — 401 if not authed.
 *   2. canEditWorkspaceContent(getEffectiveWorkspaceRole) — 403 if < member.
 *   3. hasRealWorkspaceMembership — 403 if only solo-implicit-founder.
 *
 * Writes to lazyos_permission_modes (upsert) with:
 *   - content_hash (N10, sha256 over canonical JSON).
 *   - Audit row in lazyos_permission_audit (N8, every mode change is evidence).
 *
 * Security:
 *   - Mode validation: only known values accepted → 400 otherwise.
 *   - Upsert via REPLACE INTO keeps exactly one row per workspace_id (UNIQUE).
 *   - N8: audit row written in same synchronous DB sequence (not a separate request).
 *   - N10: content_hash computed before INSERT.
 *   - N6: deterministic — no LLM or symbolic reasoning involved.
 *   - Default (no row in DB) = plan-only (resolveAllowedToolsForMode handles null).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { getDb } from '@/db/client';
import { setUserDefaultPermissionMode } from '@/lib/users/preferences-repo';
import { PERMISSION_MODES, type PermissionMode } from '../../../../../lib-v1/permission/settings/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ workspaceId: string }>;
}

// ---------------------------------------------------------------------------
// Content hash (N10) — same approach as permission-mode.ts / repo.ts
// ---------------------------------------------------------------------------

function hashRow(row: Record<string, unknown>): string {
  const STRIP = new Set(['id', 'content_hash', 'effective_since']);
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) {
    if (!STRIP.has(k) && row[k] !== undefined) stripped[k] = row[k];
  }
  // canonical JSON: keys sorted, no undefined values (matches lib-v1/audit/canonical-json.ts intent).
  return createHash('sha256').update(JSON.stringify(stripped), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Auth helper — reusable guard
// ---------------------------------------------------------------------------

function authGuard(req: NextRequest, workspaceId: string):
  | { userId: string }
  | NextResponse {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  return { userId };
}

// ---------------------------------------------------------------------------
// GET — read current mode
// ---------------------------------------------------------------------------

/**
 * Synthetic / virtual workspace IDs that never have a row in `workspaces`
 * (and therefore never a row in `lazyos_permission_modes`). For these the
 * permission-mode is functionally meaningless — the cross-workspace Root view
 * routes through `buildRootSystemPrompt`, NOT through `resolveChatToolAccess`,
 * so nothing reads a mode for them.
 *
 * Stability fix (2026-05-30, reliability sweep): the home route `/` mounts
 * `AllAccessToggle` with the synthetic `__root__` workspace as its default.
 * The toggle already guards `isRootWorkspace` and skips the mount-GET, but a
 * first-paint race (before `currentWorkspace` resolves) can still fire the GET
 * once, producing a `403` in the browser console on EVERY home-load. That 403
 * is honest (no real membership for a virtual ID) but it is pure noise — it
 * recurs forever for the owner's primary view.
 *
 * Honest fix: for a *synthetic* ID the GET returns `200 { mode: null }` (the
 * documented "no mode set → plan-only safe default") BEFORE the auth guard.
 * This is NOT an auth bypass: synthetic IDs carry no scoped data and no
 * permission decision depends on the returned value. REAL workspace IDs are
 * untouched — they still pass the full `authGuard` (401/403) below. The PATCH
 * path is deliberately NOT short-circuited: a write to a synthetic ID should
 * still be rejected by the guard (nothing should ever persist a mode for it).
 */
function isSyntheticWorkspaceId(id: string): boolean {
  return id === '__root__' || id.startsWith('__org_root__:');
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;

  if (isSyntheticWorkspaceId(workspaceId)) {
    // Virtual ID — no row possible, no permission decision depends on this.
    // Return the safe "no mode" default instead of a recurring console-403.
    return NextResponse.json({
      mode: null,
      description: 'Virtuelle Root-/Cross-Workspace-ID — kein Permission-Mode (plan-only, sicher)',
      synthetic: true,
    });
  }

  const guard = authGuard(req, workspaceId);
  if (guard instanceof NextResponse) return guard;

  try {
    const db = getDb();
    const row = db.$raw
      .prepare(`SELECT mode, effective_since, set_by FROM lazyos_permission_modes WHERE workspace_id = ? LIMIT 1`)
      .get(workspaceId) as { mode: string; effective_since: string; set_by: string } | undefined;

    if (!row) {
      // No explicit mode — default is plan-only (safe).
      return NextResponse.json({ mode: null, description: 'Kein Modus gesetzt — plan-only (sicher)' });
    }

    return NextResponse.json({
      mode: row.mode,
      effective_since: row.effective_since,
      set_by: row.set_by,
    });
  } catch (err) {
    console.error('[permission/mode GET] DB error:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH — set / update mode
// ---------------------------------------------------------------------------

interface PatchBody {
  mode?: unknown;
  /**
   * Owner fix live test 2026-05-28 — user-default propagation.
   *
   * Default behaviour is `'follow'` (owner directive: „wenn ich Vollzugriff
   * einschalte, will ich das überall haben"). So the user default is also
   * updated on every explicit PATCH. Whoever does not want that (e.g. a
   * server job that sets a workspace mode without a user learning effect) can
   * pass `propagateToUserDefault: 'skip'`.
   *
   * 'follow' is expected as a string, not a boolean — so logs are honestly
   * readable ("propagateToUserDefault: 'follow'" instead of "true").
   */
  propagateToUserDefault?: 'follow' | 'skip';
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;

  const guard = authGuard(req, workspaceId);
  if (guard instanceof NextResponse) return guard;
  const { userId } = guard;

  // Parse body.
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Validate mode.
  const modeRaw = body.mode;
  if (typeof modeRaw !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(modeRaw)) {
    return NextResponse.json(
      {
        error: 'invalid_mode',
        message: `mode muss eines von ${PERMISSION_MODES.join(', ')} sein`,
        received: modeRaw,
      },
      { status: 400 },
    );
  }
  const mode = modeRaw as PermissionMode;

  try {
    const db = getDb();
    const now = new Date().toISOString();
    const setBy = `user:${userId}`;

    // Build the row payload for N10 hash.
    const rowPayload: Record<string, unknown> = {
      workspace_id: workspaceId,
      mode,
      effective_since: now,
      set_by: setBy,
      reason: `user-selected via /api/permission/${workspaceId}/mode`,
    };
    const contentHash = hashRow(rowPayload);

    // N8: audit row — mode change is evidence, not telemetry.
    const auditPayload: Record<string, unknown> = {
      workspace_id: workspaceId,
      org_id: null,
      tool_class: 'permission-mode-change',
      tool_name: 'permission-mode-route',
      op: `SET_MODE:${mode}`,
      mode,
      would_allow: 1,
      reason: `user ${userId} set permission mode to '${mode}' via API`,
      enforcement: 'audit',
    };
    const auditHash = hashRow(auditPayload);

    // LOW #4 (2026-05-25): mode-upsert + audit-row run in ONE transaction.
    // N8 fail-closed: if the audit insert throws, the mode change is rolled
    // back too — we never persist a permission change without its evidence row.
    const persist = db.$raw.transaction(() => {
      // Upsert: ON CONFLICT respects UNIQUE(workspace_id).
      // Keeps exactly one row per workspace (idempotent, N10-consistent).
      db.$raw
        .prepare(
          `INSERT INTO lazyos_permission_modes
             (workspace_id, mode, effective_since, set_by, reason, content_hash)
           VALUES
             (@workspace_id, @mode, @effective_since, @set_by, @reason, @content_hash)
           ON CONFLICT(workspace_id) DO UPDATE SET
             mode            = excluded.mode,
             effective_since = excluded.effective_since,
             set_by          = excluded.set_by,
             reason          = excluded.reason,
             content_hash    = excluded.content_hash`,
        )
        .run({ ...rowPayload, content_hash: contentHash });

      db.$raw
        .prepare(
          `INSERT INTO lazyos_permission_audit
             (workspace_id, org_id, tool_class, tool_name, op,
              mode, would_allow, reason, enforcement, content_hash)
           VALUES
             (@workspace_id, @org_id, @tool_class, @tool_name, @op,
              @mode, @would_allow, @reason, @enforcement, @content_hash)`,
        )
        .run({ ...auditPayload, content_hash: auditHash });
    });
    persist();

    // ──────────────────────────────────────────────────────────────────────
    // Owner fix live test 2026-05-28: user-default propagation.
    //
    // Mirror the mode the user just chose onto their
    // system-wide default (`user_preferences.default_permission_mode`),
    // so that a workspace created next shows the same state without another
    // toggle.
    //
    // Owner directive (verbatim 2026-05-28): „Vollzugriff war bereits
    // aktiviert. im neuen Workspace war es nicht aktiviert. Ggf. diese
    // Einstellung Systemübergreifend nutzbar machen."
    //
    // Security note: this step writes NO workspace permission.
    // The per-workspace truth stays `lazyos_permission_modes` (just written
    // above). `user_preferences` is ONLY the UI/seed-hint layer.
    // Foreign workspaces can inherit nothing — they either have an
    // explicit mode or fall back at runtime to the safe default.
    //
    // Failure mode: if the preference update throws, we still return the PATCH
    // as successful — the workspace mode is set, after all.
    const propagate: 'follow' | 'skip' =
      body.propagateToUserDefault === 'skip' ? 'skip' : 'follow';
    let userDefaultUpdated = false;
    if (propagate === 'follow') {
      try {
        setUserDefaultPermissionMode({
          userId,
          mode,
          reason: `set via PATCH /api/permission/${workspaceId}/mode`,
          source: 'permission-toggle',
        });
        userDefaultUpdated = true;
      } catch (err) {
        // Non-fatal: the workspace mode is already persisted. We log
        // and honestly tell the client that the default mirror did not take.
        console.warn(
          '[permission/mode PATCH] user-default propagation failed (non-fatal):',
          err,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      mode,
      effective_since: now,
      content_hash: contentHash,
      user_default_updated: userDefaultUpdated,
    });
  } catch (err) {
    console.error('[permission/mode PATCH] DB error:', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
