/**
 * DELETE /api/sessions/[uuid] — archives (does not delete) a Claude session.
 *
 * We NEVER delete the JSONL file (audit trail / replay). Instead:
 *   - move to ~/.claude/projects/<slug>/archived/<uuid>.jsonl
 *   - if the session was the active one of the workspace → the claude_sessions
 *     entry is set to NULL (next chat spawns a fresh UUID).
 */

import fs from 'node:fs';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { getDb } from '@/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOME = process.env.HOME ?? '/root';
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ uuid: string }> },
): Promise<Response> {
  const { uuid } = await params;
  if (!uuid || !/^[a-f0-9-]{20,}$/i.test(uuid)) {
    return NextResponse.json({ error: 'invalid_uuid' }, { status: 400 });
  }

  // Find the JSONL file across all project-slugs
  let foundPath: string | null = null;
  let foundSlug: string | null = null;
  try {
    const slugs = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const candidate = path.join(CLAUDE_PROJECTS_DIR, s.name, `${uuid}.jsonl`);
      if (fs.existsSync(candidate)) {
        foundPath = candidate;
        foundSlug = s.name;
        break;
      }
    }
  } catch {
    return NextResponse.json({ error: 'scan_failed' }, { status: 500 });
  }

  if (!foundPath || !foundSlug) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }

  // Archive: move to <slug>/archived/<uuid>.jsonl
  try {
    const archiveDir = path.join(CLAUDE_PROJECTS_DIR, foundSlug, 'archived');
    fs.mkdirSync(archiveDir, { recursive: true });
    const dest = path.join(archiveDir, `${uuid}.jsonl`);
    fs.renameSync(foundPath, dest);
  } catch (err) {
    return NextResponse.json(
      { error: 'archive_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // If this was the active session of any workspace — clear it
  try {
    const db = getDb();
    db.$raw
      .prepare(
        `UPDATE claude_sessions SET session_id = NULL, last_result = 'archived', updated_at = ? WHERE session_id = ?`,
      )
      .run(Date.now(), uuid);
  } catch {
    // non-fatal; archive worked
  }

  return NextResponse.json({ ok: true, uuid, archived: true });
}
