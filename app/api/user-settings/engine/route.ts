/**
 * Engine-Preference per User (Track 2 of "Engine-Pill 2026-05-23").
 *
 * GET  /api/user-settings/engine        → { mode: EngineMode }
 * POST /api/user-settings/engine { mode } → { ok, mode }
 *
 * Persistence-Decision:
 *   - We REUSE the `users.oss_onboarding_state` JSON-blob (Migration 0054)
 *     instead of adding a new column. That keeps the migration-surface
 *     stable and the data lives next to onboarding-completion anyway.
 *   - The Engine-Pill primary persistence is localStorage; this DB-backed
 *     endpoint is the cross-device sync path. localStorage wins on read
 *     conflict (UI is single-source for what the user clicked last).
 *
 * Valid modes: 'parallel-all' | 'claude-cli' | 'codex-cli' | 'ollama'.
 *               Default 'parallel-all'.
 *
 * 'claude-api' wurde 2026-05-23 entfernt — claude-cli (MAX-Plan-OAuth)
 * covert denselben Use-Case zero-cost. Alte localStorage/DB-Eintraege
 * mit `claude-api` werden silent auf 'parallel-all' downgraded.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { eq, sql } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { users } from '@/db/schema/users';
import { loadCurrentUser } from '@/lib/users/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_MODES = new Set([
  'parallel-all',
  'claude-cli',
  'codex-cli',
  'ollama',
]);
const DEFAULT_MODE = 'parallel-all';

type Mode = string;

interface PostBody {
  mode?: string;
}

function readBlob(userId: string): Record<string, unknown> {
  const db = getDb();
  const rows = db
    .select({ s: sql<string | null>`oss_onboarding_state` })
    .from(users)
    .where(eq(users.id, userId))
    .all();
  const raw = rows[0]?.s ?? null;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeBlob(userId: string, blob: Record<string, unknown>): void {
  const db = getDb();
  db.run(sql`
    UPDATE users
       SET oss_onboarding_state = ${JSON.stringify(blob)},
           updated_at = ${Date.now()}
     WHERE id = ${userId}
  `);
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  const blob = readBlob(user.id);
  const data = (blob.data as Record<string, unknown> | undefined) ?? {};
  const stored = typeof data.preferredEngine === 'string' ? (data.preferredEngine as Mode) : null;
  const mode = stored && VALID_MODES.has(stored) ? stored : DEFAULT_MODE;
  return NextResponse.json({ mode });
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const mode = (body.mode ?? '').trim();
  if (!VALID_MODES.has(mode)) {
    return NextResponse.json(
      { error: 'invalid-mode', mode, allowed: [...VALID_MODES] },
      { status: 400 },
    );
  }

  const blob = readBlob(user.id);
  const data = (blob.data as Record<string, unknown> | undefined) ?? {};
  data.preferredEngine = mode;
  blob.data = data;
  writeBlob(user.id, blob);

  return NextResponse.json({ ok: true, mode });
}
