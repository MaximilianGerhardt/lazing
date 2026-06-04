/**
 * GET /api/workspaces — list all known workspaces.
 *
 * Primary path: proxy to the VPS instance (which owns the authoritative
 * SQLite). Fallback: read the local DB; if that also fails, return the
 * static list baked into the client so the switcher never renders empty.
 *
 * See `lib/vps-bridge/` for the proxy implementation and the
 * degraded-response contract.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { mkdirSync } from 'node:fs';

import { getDb } from '@/db/client';
import { STATIC_WORKSPACES } from '@/lib/nav/workspaces-data';
import { defaultWorkspacePath } from '@/lib/workspaces/projects-root';
import type { Workspace, WorkspaceAccent } from '@/lib/nav/types';
import { findOrgById, findUserOrgMembership, listOrgsForUser } from '@/lib/orgs/repo';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getUserDefaultPermissionMode } from '@/lib/users/preferences-repo';
import { bridgeOrLocal } from '@/lib/vps-bridge/route-helpers';
// Owner-Bug-Fix 2026-05-29 (F2 ID-Kollisions-Schutz):
// disambiguateWorkspaceId verhindert, dass ein neu erstellter Workspace
// mit gleichem Label (= gleicher Slug) Audit-Spuren des Vorgängers
// adoptiert (z.B. alten chat_ledger.coord_key).
import { disambiguateWorkspaceId } from '@/lib/workspaces/cleanup';
import { PERMISSION_MODES, type PermissionMode } from '../../../lib-v1/permission/settings/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WorkspaceRow {
  id: string;
  label: string;
  accent: string;
  sensitivity: string | null;
  archived: number | null;
  organization_id: string | null;
  /** Phase IA-Konsolidierung 2026-04-29: workspace-Type für Section-Gruppierung. */
  workspace_type: string | null;
  /** 2026-05-03: User-driven Sub-Segmentierung innerhalb einer Org. */
  context_group: string | null;
  org_name: string | null;
  org_type: string | null;
  org_parent_id: string | null;
  org_palette_index: number | null;
}

const ALLOWED_ACCENTS: ReadonlySet<WorkspaceAccent> = new Set([
  'north',
  'clientb',
  'own',
  'private',
  'claude',
  'codex',
  'error',
]);

function toAccent(raw: string): WorkspaceAccent {
  return (ALLOWED_ACCENTS.has(raw as WorkspaceAccent)
    ? (raw as WorkspaceAccent)
    : 'north');
}

function toSensitivity(raw: string | null): Workspace['sensitivity'] {
  if (raw === 'high' || raw === 'normal' || raw === 'low') return raw;
  return 'low';
}

function readLocalWorkspaces(): Response {
  try {
    const db = getDb();
    const rows = db.$raw
      .prepare(
        `SELECT w.id, w.label, w.accent, w.sensitivity, w.archived,
                w.organization_id, w.workspace_type, w.context_group,
                o.name as org_name, o.type as org_type,
                o.parent_id as org_parent_id, o.palette_index as org_palette_index
           FROM workspaces w
           LEFT JOIN organizations o ON w.organization_id = o.id
          WHERE w.archived = 0
          ORDER BY w.label ASC`,
      )
      .all() as WorkspaceRow[];

    if (rows.length === 0) {
      return NextResponse.json(
        { workspaces: STATIC_WORKSPACES, source: 'static_fallback' },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    const workspaces: Workspace[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      accent: toAccent(r.accent),
      sensitivity: toSensitivity(r.sensitivity),
      archived: !!r.archived,
      organizationId: r.organization_id ?? null,
      workspaceType: r.workspace_type ?? 'default',
      contextGroup: r.context_group ?? null,
      organization:
        r.organization_id && r.org_name
          ? {
              id: r.organization_id,
              name: r.org_name,
              type: (r.org_type ?? 'company') as Workspace['organization'] extends infer O
                ? O extends { type: infer T }
                  ? T
                  : never
                : never,
              parentId: r.org_parent_id ?? null,
              paletteIndex: r.org_palette_index ?? 0,
            }
          : null,
    }));

    return NextResponse.json(
      { workspaces, source: 'db' },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    // DB absent (e.g. workspaces table not yet migrated, or Vercel /tmp
    // ephemeral DB) — fall back to static.
    return NextResponse.json(
      { workspaces: STATIC_WORKSPACES, source: 'static_fallback' },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
}

export async function GET(): Promise<Response> {
  return bridgeOrLocal<{ workspaces: Workspace[]; source?: string }>({
    path: '/api/workspaces',
    fallback: () => readLocalWorkspaces(),
    validate: (body): body is { workspaces: Workspace[]; source?: string } => {
      if (!body || typeof body !== 'object') return false;
      const w = (body as { workspaces?: unknown }).workspaces;
      return Array.isArray(w);
    },
  });
}

/**
 * POST /api/workspaces — Phase AU.3.4 Workspace-Create.
 *
 * Body: { id?, label, sensitivity?, organizationId, path? }
 *
 * Auth: User muss in `organizationId` mindestens member sein. Bei ID
 * ohne Slug bauen wir einen aus dem Label. Workspace-Membership wird
 * automatisch als „inherits-from-org" für den User gesetzt.
 */
interface CreateWorkspaceBody {
  id?: string;
  label?: string;
  sensitivity?: string;
  organizationId?: string;
  path?: string;
  /**
   * 2026-05-03: Workspace-Type-Whitelist. Default 'default' (= „Sonstig").
   * Ungültige Werte fallen auf 'default' zurück (silent fallback statt 400,
   * weil das Field optional ist und client-seitig vorgewählt wird).
   */
  workspaceType?: string;
  /**
   * 2026-05-03: Optionaler User-driven Kontext-Tag für Sub-Segmentierung.
   * Trim, max 32 Zeichen. Leer/whitespace-only → NULL.
   */
  contextGroup?: string;
  /**
   * ACL-3 (2026-05-24): Credential-Isolation-Toggle.
   * 'inherit'  — darf Org-Credentials als Fallback nutzen (Standard intern).
   * 'isolated' — ausschließlich eigene Credentials, kein Org-Fallback (extern).
   * Wenn nicht übergeben: wird aus Org-Type abgeleitet (client → isolated,
   * sonst inherit). Explizit übergebener Wert gewinnt immer.
   */
  credentialIsolation?: string;
}

const ID_RE = /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i;
const ORG_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const WORKSPACE_TYPES = new Set([
  'company',
  'product',
  'client',
  'tool',
  'private',
  'default',
]);
const CONTEXT_GROUP_MAX = 32;
/** ACL-3: Credential-Isolation Whitelist. */
const CREDENTIAL_ISOLATION_VALUES = new Set(['inherit', 'isolated']);
/**
 * Org-/Workspace-Rollen mit Edit-Recht (rank ≥ member, s. lib/security/permissions
 * ROLE_RANK). Genutzt bei der Workspace-Erstellung: Org-Wahl bevorzugt eine
 * Edit-Org, und der Ersteller bekommt eine direkte Edit-Membership.
 */
const WORKSPACE_EDIT_ROLES = new Set(['founder', 'admin', 'member']);

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'auth-required' },
      { status: 401 },
    );
  }

  let body: CreateWorkspaceBody;
  try {
    body = (await req.json()) as CreateWorkspaceBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  const label = body.label?.trim();
  if (!label || label.length < 2) {
    return NextResponse.json(
      { error: 'invalid-label', hint: 'label muss ≥2 Zeichen sein' },
      { status: 400 },
    );
  }

  // GitHub-optional direktive 2026-05-23: `organizationId` is now OPTIONAL.
  // If the client did not pass one, derive it from the user's existing org
  // memberships (first one wins — typically the personal org seeded at
  // signup). This lets a fresh user create a workspace from `name` alone
  // without ever touching GitHub or org-pickers.
  let orgId = body.organizationId?.trim();
  if (!orgId) {
    const orgs = listOrgsForUser(userId);
    if (orgs.length === 0) {
      return NextResponse.json(
        {
          error: 'no-org-membership',
          hint: 'User hat keine Org-Mitgliedschaft — bitte ggf. Onboarding wiederholen.',
        },
        { status: 422 },
      );
    }
    // Fix B2 (2026-06-02): NICHT blind die erste Org nehmen — bevorzuge eine, in
    // der der User editieren darf (rank ≥ member). Sonst landete ein per
    // Quick-Create angelegter Workspace in einer Viewer-Org und war sofort
    // read-only-degradiert (projection/permission 403). Fallback: erste Org.
    const owned = orgs.find((o) => {
      const m = findUserOrgMembership(userId, o.id);
      return m !== null && WORKSPACE_EDIT_ROLES.has(m.role);
    });
    orgId = (owned ?? orgs[0]).id;
  } else if (!ORG_ID_RE.test(orgId)) {
    return NextResponse.json(
      { error: 'invalid-organization-id', hint: 'organizationId-Format ungültig' },
      { status: 400 },
    );
  }

  // Permission: User muss in der Org member oder höher sein.
  const membership = findUserOrgMembership(userId, orgId);
  if (!membership) {
    return NextResponse.json(
      {
        error: 'forbidden',
        hint: 'Du bist kein Mitglied der angegebenen Org.',
      },
      { status: 403 },
    );
  }

  const explicitId = body.id?.trim().toLowerCase();
  let id = explicitId || slugify(label);
  if (!ID_RE.test(id)) {
    return NextResponse.json(
      { error: 'invalid-id', hint: 'id-Format ungültig' },
      { status: 400 },
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Owner-Bug-Fix 2026-05-29 — F2: Workspace-ID-Kollisions-Schutz.
  //
  // Symptom (verbatim N1, Owner-Live-Test):
  //   „Ich nehme den Namen PA Website 2 und öffne den Chat nach dem neu
  //    erstellen und dann it da der alte Chatverlauf drin…"
  //
  // Root-Cause: slugify(label)='example-website-2' war IDENTISCH mit der
  // gelöschten Vorgänger-Workspace. Tabellen, die per `coord_key` /
  // `workspace_id` joinen (chat_ledger, …) hatten stale Rows aus dem
  // Cleanup übersehen → die NEUE Workspace „adoptierte" sie.
  //
  // Schutz: wenn der Slug AUTO-DERIVED ist (kein expliziter body.id),
  // probieren wir nicht nur ob er in `workspaces.id` frei ist, sondern
  // ob er IRGENDWO in workspace-gebundenen Tabellen Spuren hinterlässt
  // (chat_ledger.coord_key, workstreams.workspace_id, lazyos_permission_*,
  // events.segment_id, …). Bei Treffer hängen wir `-2`, `-3`, … an, bis
  // der Slug *audit-frei* ist. Notausgang: 4-stelliger Random-Suffix.
  //
  // Label bleibt verbatim (Owner sieht weiter „PA Website 2"); NUR die
  // interne `id` wird disambiguiert.
  //
  // Wenn der User EXPLIZIT eine `id` übergeben hat, machen wir das NICHT —
  // ein expliziter ID-Wunsch bekommt das alte Verhalten (409 bei Konflikt),
  // weil der User damit signalisiert dass er weiß was er tut.
  // ──────────────────────────────────────────────────────────────────────
  const db = getDb();
  if (!explicitId) {
    try {
      const disambiguated = disambiguateWorkspaceId(db.$raw, id);
      if (disambiguated !== id) {
        console.warn(
          `[workspaces POST] F2 disambiguated slug: "${id}" → "${disambiguated}" (stale audit traces detected)`,
        );
        id = disambiguated;
      }
    } catch (err) {
      // F2 ist additiv + fail-soft: wenn der Probe scheitert, fallen wir
      // auf die alte Logik zurück (409 bei collision). Im schlimmsten
      // Fall sieht der Owner den alten Chat — kein neuer Bug.
      console.warn('[workspaces POST] F2 disambiguation skipped (non-fatal):', err);
    }
  }

  const sensitivity =
    body.sensitivity === 'high' || body.sensitivity === 'normal'
      ? body.sensitivity
      : 'low';
  // Fix A1 (2026-06-02): Neue Workspaces bekommen einen NUTZBAREN FS-Pfad.
  // Ohne Pfad konnte der Chat-Agent (workspace-session, cwd=ws.path) keine
  // Dateien schreiben → ein „bau mir das"-Intent fiel auf Klärungsfragen
  // zurück statt zu bauen (der beobachtete Brainstorm→Bau-Loop). Expliziter
  // Pfad gewinnt; sonst der deterministische Default `<projectsRoot>/<id>`.
  // Verzeichnis best-effort anlegen, damit der erste Build sofort funktioniert.
  const explicitPath =
    typeof body.path === 'string' && body.path.trim().length > 0
      ? body.path.slice(0, 500)
      : '';
  const path = explicitPath || defaultWorkspacePath(id);
  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    console.warn(
      '[workspaces POST] mkdir workspace path failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 2026-05-03: Workspace-Type Whitelist + Default-Fallback.
  const workspaceType =
    typeof body.workspaceType === 'string' &&
    WORKSPACE_TYPES.has(body.workspaceType)
      ? body.workspaceType
      : 'default';

  // 2026-05-03: Context-Group — trim, max 32 chars, NULL wenn leer.
  let contextGroup: string | null = null;
  if (typeof body.contextGroup === 'string') {
    const trimmed = body.contextGroup.trim().slice(0, CONTEXT_GROUP_MAX);
    contextGroup = trimmed.length > 0 ? trimmed : null;
  }

  // ACL-3 (2026-05-24): Credential-Isolation-Ableitung.
  // Regel: explizit übergebener Wert gewinnt. Sonst: Org-Type 'client' → 'isolated',
  // alle anderen Org-Types → 'inherit'.
  let credentialIsolation: 'inherit' | 'isolated';
  if (
    typeof body.credentialIsolation === 'string' &&
    CREDENTIAL_ISOLATION_VALUES.has(body.credentialIsolation)
  ) {
    credentialIsolation = body.credentialIsolation as 'inherit' | 'isolated';
  } else {
    // Ableiten aus Org-Type: 'client' = externer Kunde → immer isoliert.
    const org = findOrgById(orgId);
    credentialIsolation = org?.type === 'client' ? 'isolated' : 'inherit';
  }

  // Conflict-Check (db wurde oben bereits via getDb() initialisiert für F2).
  const existing = db.$raw
    .prepare('SELECT id FROM workspaces WHERE id = ?')
    .get(id) as { id: string } | undefined;
  if (existing) {
    return NextResponse.json(
      { error: 'id-taken', message: `Workspace-id "${id}" existiert bereits` },
      { status: 409 },
    );
  }

  const now = Date.now();
  db.$raw
    .prepare(
      `INSERT INTO workspaces (
         id, label, accent, path, sensitivity, archived, organization_id,
         workspace_type, context_group, credential_isolation,
         created_at, updated_at
       ) VALUES (?, ?, 'own', ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      label,
      path,
      sensitivity,
      orgId,
      workspaceType,
      contextGroup,
      credentialIsolation,
      now,
      now,
    );

  // Workspace-Membership für den Ersteller.
  // Fix B1 (2026-06-02): Der Ersteller BESITZT seinen Workspace — direkte
  // (inherits_from_org=0) Membership mit Edit-Rolle. Sonst erbte er die
  // Org-Rolle (inherits_from_org=1); bei einer Viewer-Org ließ
  // getEffectiveWorkspaceRole (Schritt 1 wird nur bei !inheritsFromOrg genutzt)
  // auf die Viewer-Org-Rolle durchfallen → member-gated Reads (projection,
  // permission-mode) 403en → jeder frische Workspace war read-only-degradiert.
  // Edit-fähige Org-Rolle wird übernommen; sonst Default 'admin' (du hast ihn
  // erstellt → du verwaltest ihn).
  const memId = `wm_${Math.random().toString(36).slice(2, 8)}_${now}`;
  const creatorRole = WORKSPACE_EDIT_ROLES.has(membership.role)
    ? membership.role
    : 'admin';
  db.$raw
    .prepare(
      `INSERT INTO workspace_memberships (
         id, user_id, workspace_id, role, inherits_from_org,
         invited_by_user_id, joined_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    .run(memId, userId, id, creatorRole, now, now);

  // ──────────────────────────────────────────────────────────────────────
  // Owner-Fix Live-Test 2026-05-28: System-übergreifender Permission-Mode.
  //
  // Wenn der User bereits einen Default-Permission-Mode hinterlegt hat
  // (lib/users/preferences-repo.ts → user_preferences.default_permission_mode)
  // UND der Default sinnvoll ist (NICHT 'ask' — 'ask' ist der UI-Default,
  // den die Pill ohnehin zeigt wenn keine explizite Row existiert), seeden
  // wir die `lazyos_permission_modes`-Row der neuen Workspace SOFORT mit
  // dem User-Default.
  //
  // Wirkung: der nächste Browser-Mount der `AllAccessToggle`-Pill liest den
  // expliziten Workspace-Mode (er ist jetzt da) und zeigt den korrekten
  // Stand, ohne dass der Owner erst toggeln muss.
  //
  // Sicherheits-Kontrolle:
  //   - Wir schreiben den Mode NUR für die soeben angelegte Workspace
  //     (Owner ist per definitionem Member → autorisiert).
  //   - Wir leaken den User-Default NICHT in Workspaces fremder User —
  //     fremde User sehen ihn ohnehin nie, weil sie keine Preference-Row
  //     unter unserem `user_id` lesen.
  //   - N8 Audit: wir schreiben in EINER Transaktion die mode-row + audit-
  //     row mit klarem `reason='seeded-from-user-default'`, damit später
  //     erkennbar ist, dass nicht der User selbst diesen Mode aktiv gesetzt
  //     hat sondern der System-Default-Mechanismus.
  //   - N10 content_hash: über die fachlichen Felder (sha256 / canonical-JSON),
  //     identisch zur PATCH-Route in app/api/permission/[workspaceId]/mode.
  //   - Wir schlucken Fehler aus dem Seed, weil die Workspace-Anlage selbst
  //     bereits erfolgreich war — der User sieht im schlimmsten Fall die
  //     Pill „AUS" und kann manuell toggeln (also der heutige Status, mit
  //     dem Owner-Fix als Best-Effort-Aufstockung obendrauf).
  try {
    const userDefault = getUserDefaultPermissionMode(userId);
    if (
      userDefault !== null &&
      userDefault !== 'ask' &&
      (PERMISSION_MODES as readonly string[]).includes(userDefault)
    ) {
      const seededMode = userDefault as PermissionMode;
      const seedTs = new Date().toISOString();
      const setBy = `user:${userId}`;
      const reason = `seeded-from-user-default on workspace create (user_preferences.default_permission_mode='${seededMode}')`;

      const seedRow: Record<string, unknown> = {
        workspace_id: id,
        mode: seededMode,
        effective_since: seedTs,
        set_by: setBy,
        reason,
      };
      const seedHash = createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(seedRow).sort(([a], [b]) => a.localeCompare(b)),
            ),
          ),
          'utf8',
        )
        .digest('hex');

      const auditRow: Record<string, unknown> = {
        workspace_id: id,
        org_id: orgId,
        tool_class: 'permission-mode-change',
        tool_name: 'workspaces-create-route',
        op: `SEED_MODE:${seededMode}`,
        mode: seededMode,
        would_allow: 1,
        reason: `seeded by POST /api/workspaces from user-default for user ${userId}`,
        enforcement: 'audit',
      };
      const auditHash = createHash('sha256')
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(auditRow).sort(([a], [b]) => a.localeCompare(b)),
            ),
          ),
          'utf8',
        )
        .digest('hex');

      const persistSeed = db.$raw.transaction(() => {
        db.$raw
          .prepare(
            `INSERT INTO lazyos_permission_modes
               (workspace_id, mode, effective_since, set_by, reason, content_hash)
             VALUES
               (@workspace_id, @mode, @effective_since, @set_by, @reason, @content_hash)
             ON CONFLICT(workspace_id) DO NOTHING`,
          )
          .run({ ...seedRow, content_hash: seedHash });

        db.$raw
          .prepare(
            `INSERT INTO lazyos_permission_audit
               (workspace_id, org_id, tool_class, tool_name, op,
                mode, would_allow, reason, enforcement, content_hash)
             VALUES
               (@workspace_id, @org_id, @tool_class, @tool_name, @op,
                @mode, @would_allow, @reason, @enforcement, @content_hash)`,
          )
          .run({ ...auditRow, content_hash: auditHash });
      });
      persistSeed();
    }
  } catch (err) {
    // Best-effort: der Workspace ist bereits angelegt. Fallback = manueller Toggle.
    console.warn('[workspaces POST] permission-mode seed failed (non-fatal):', err);
  }

  return NextResponse.json(
    {
      workspace: {
        id,
        label,
        sensitivity,
        organizationId: orgId,
        path,
        workspaceType,
        contextGroup,
        credentialIsolation,
      },
    },
    { status: 201 },
  );
}
