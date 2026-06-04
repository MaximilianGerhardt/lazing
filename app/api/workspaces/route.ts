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
// Owner bug fix 2026-05-29 (F2 ID collision protection):
// disambiguateWorkspaceId prevents a newly created workspace
// with the same label (= same slug) from adopting the predecessor's audit
// traces (e.g. an old chat_ledger.coord_key).
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
  /** Phase IA consolidation 2026-04-29: workspace type for section grouping. */
  workspace_type: string | null;
  /** 2026-05-03: user-driven sub-segmentation within an org. */
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
 * POST /api/workspaces — Phase AU.3.4 workspace create.
 *
 * Body: { id?, label, sensitivity?, organizationId, path? }
 *
 * Auth: user must be at least a member of `organizationId`. For an id
 * without a slug we build one from the label. Workspace membership is set
 * automatically as "inherits-from-org" for the user.
 */
interface CreateWorkspaceBody {
  id?: string;
  label?: string;
  sensitivity?: string;
  organizationId?: string;
  path?: string;
  /**
   * 2026-05-03: workspace-type whitelist. Default 'default' (= "Other").
   * Invalid values fall back to 'default' (silent fallback instead of 400,
   * because the field is optional and preselected on the client side).
   */
  workspaceType?: string;
  /**
   * 2026-05-03: optional user-driven context tag for sub-segmentation.
   * Trimmed, max 32 chars. Empty/whitespace-only → NULL.
   */
  contextGroup?: string;
  /**
   * ACL-3 (2026-05-24): credential-isolation toggle.
   * 'inherit'  — may use org credentials as a fallback (default internal).
   * 'isolated' — exclusively own credentials, no org fallback (external).
   * If not passed: derived from the org type (client → isolated,
   * otherwise inherit). An explicitly passed value always wins.
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
/** ACL-3: credential-isolation whitelist. */
const CREDENTIAL_ISOLATION_VALUES = new Set(['inherit', 'isolated']);
/**
 * Org/workspace roles with edit rights (rank ≥ member, see lib/security/permissions
 * ROLE_RANK). Used during workspace creation: org choice prefers an
 * edit org, and the creator gets a direct edit membership.
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
    // Fix B2 (2026-06-02): do NOT blindly take the first org — prefer one in
    // which the user may edit (rank ≥ member). Otherwise a workspace created via
    // quick-create landed in a viewer org and was immediately
    // read-only-degraded (projection/permission 403). Fallback: first org.
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

  // Permission: user must be a member of the org or higher.
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
  // Owner bug fix 2026-05-29 — F2: workspace-ID collision protection.
  //
  // Symptom (verbatim N1, owner live test):
  //   „Ich nehme den Namen PA Website 2 und öffne den Chat nach dem neu
  //    erstellen und dann it da der alte Chatverlauf drin…"
  //
  // Root cause: slugify(label)='example-website-2' was IDENTICAL to the
  // deleted predecessor workspace. Tables that join via `coord_key` /
  // `workspace_id` (chat_ledger, …) had stale rows missed by the
  // cleanup → the NEW workspace "adopted" them.
  //
  // Protection: if the slug is AUTO-DERIVED (no explicit body.id),
  // we probe not only whether it is free in `workspaces.id`, but
  // whether it leaves traces ANYWHERE in workspace-bound tables
  // (chat_ledger.coord_key, workstreams.workspace_id, lazyos_permission_*,
  // events.segment_id, …). On a hit we append `-2`, `-3`, … until
  // the slug is *audit-free*. Emergency exit: 4-digit random suffix.
  //
  // The label stays verbatim (the owner still sees "PA Website 2"); ONLY the
  // internal `id` is disambiguated.
  //
  // If the user EXPLICITLY passed an `id`, we do NOT do this —
  // an explicit id wish gets the old behavior (409 on conflict),
  // because with it the user signals that they know what they are doing.
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
      // F2 is additive + fail-soft: if the probe fails, we fall back
      // to the old logic (409 on collision). In the worst
      // case the owner sees the old chat — no new bug.
      console.warn('[workspaces POST] F2 disambiguation skipped (non-fatal):', err);
    }
  }

  const sensitivity =
    body.sensitivity === 'high' || body.sensitivity === 'normal'
      ? body.sensitivity
      : 'low';
  // Fix A1 (2026-06-02): new workspaces get a USABLE FS path.
  // Without a path the chat agent (workspace-session, cwd=ws.path) could not
  // write files → a "build me this" intent fell back to clarifying questions
  // instead of building (the observed brainstorm→build loop). An explicit
  // path wins; otherwise the deterministic default `<projectsRoot>/<id>`.
  // Create the directory best-effort so the first build works immediately.
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

  // 2026-05-03: workspace-type whitelist + default fallback.
  const workspaceType =
    typeof body.workspaceType === 'string' &&
    WORKSPACE_TYPES.has(body.workspaceType)
      ? body.workspaceType
      : 'default';

  // 2026-05-03: context group — trim, max 32 chars, NULL when empty.
  let contextGroup: string | null = null;
  if (typeof body.contextGroup === 'string') {
    const trimmed = body.contextGroup.trim().slice(0, CONTEXT_GROUP_MAX);
    contextGroup = trimmed.length > 0 ? trimmed : null;
  }

  // ACL-3 (2026-05-24): credential-isolation derivation.
  // Rule: an explicitly passed value wins. Otherwise: org type 'client' → 'isolated',
  // all other org types → 'inherit'.
  let credentialIsolation: 'inherit' | 'isolated';
  if (
    typeof body.credentialIsolation === 'string' &&
    CREDENTIAL_ISOLATION_VALUES.has(body.credentialIsolation)
  ) {
    credentialIsolation = body.credentialIsolation as 'inherit' | 'isolated';
  } else {
    // Derive from org type: 'client' = external customer → always isolated.
    const org = findOrgById(orgId);
    credentialIsolation = org?.type === 'client' ? 'isolated' : 'inherit';
  }

  // Conflict check (db was already initialized above via getDb() for F2).
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

  // Workspace membership for the creator.
  // Fix B1 (2026-06-02): the creator OWNS their workspace — direct
  // (inherits_from_org=0) membership with an edit role. Otherwise they inherited
  // the org role (inherits_from_org=1); with a viewer org
  // getEffectiveWorkspaceRole (step 1 is only used when !inheritsFromOrg)
  // fell through to the viewer org role → member-gated reads (projection,
  // permission-mode) 403'd → every fresh workspace was read-only-degraded.
  // An edit-capable org role is taken over; otherwise default 'admin' (you
  // created it → you manage it).
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
  // Owner fix live test 2026-05-28: cross-system permission mode.
  //
  // If the user has already stored a default permission mode
  // (lib/users/preferences-repo.ts → user_preferences.default_permission_mode)
  // AND the default is meaningful (NOT 'ask' — 'ask' is the UI default
  // the pill shows anyway when no explicit row exists), we seed
  // the new workspace's `lazyos_permission_modes` row IMMEDIATELY with
  // the user default.
  //
  // Effect: the next browser mount of the `AllAccessToggle` pill reads the
  // explicit workspace mode (it is now there) and shows the correct
  // state, without the owner having to toggle first.
  //
  // Security control:
  //   - We write the mode ONLY for the just-created workspace
  //     (the owner is by definition a member → authorized).
  //   - We do NOT leak the user default into other users' workspaces —
  //     other users never see it anyway, because they do not read a preference
  //     row under our `user_id`.
  //   - N8 audit: in ONE transaction we write the mode row + audit
  //     row with a clear `reason='seeded-from-user-default'`, so that later
  //     it is recognizable that it was not the user who actively set this mode
  //     but the system default mechanism.
  //   - N10 content_hash: over the domain fields (sha256 / canonical JSON),
  //     identical to the PATCH route in app/api/permission/[workspaceId]/mode.
  //   - We swallow errors from the seed, because the workspace creation itself
  //     already succeeded — in the worst case the user sees the
  //     pill "OFF" and can toggle manually (i.e. today's status, with
  //     the owner fix as a best-effort top-up on top).
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
    // Best-effort: the workspace is already created. Fallback = manual toggle.
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
