/**
 * POST /api/rag/index
 *
 * Body: { workspaceId: string, sources?: 'files' | 'chat' | 'all' }
 *
 * Synchron startet einen RAG-Index-Lauf via lib/rag/indexer. Bei großen
 * Workspaces läuft das mehrere Minuten — UI sollte einen Background-Toast
 * zeigen und dann /api/rag/status pollen.
 *
 * Loop-Guard: indexBatch hat eingebaute 60s-Recursion-Debounce +
 * Circuit-Breaker (rag_indexer_state.circuit_open).
 *
 * Auth: nur Workspace-Editors.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { getWorkspace } from '@/lib/workspaces';
import { indexBatch, type IndexableSource } from '@/lib/rag/indexer';
import { getDb } from '@/db/client';
import { events } from '@/db/schema/events';
import { eq, and, desc } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  workspaceId: z.string().min(1).max(64),
  sources: z.enum(['files', 'chat', 'all']).default('all'),
  maxChat: z.number().int().min(10).max(2000).default(300),
});

const FILE_EXT_WHITELIST = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.md', '.mdx', '.txt', '.sql', '.json', '.yaml', '.yml',
  '.css', '.scss', '.py', '.go', '.rs',
]);
const FILE_DIR_BLACKLIST = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'out', 'coverage', '.turbo', '.vercel', '.expo',
]);
const MAX_FILE_BYTES = 200 * 1024;
const MAX_FILES_PER_RUN = 1500;

function* walkFiles(root: string): Generator<{ abs: string; rel: string }> {
  const dirs: string[] = [root];
  let yielded = 0;
  while (dirs.length > 0 && yielded < MAX_FILES_PER_RUN) {
    const dir = dirs.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (FILE_DIR_BLACKLIST.has(name)) continue;
      if (name.startsWith('.') && name !== '.env.example') continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        dirs.push(abs);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        const ext = extname(name).toLowerCase();
        if (!FILE_EXT_WHITELIST.has(ext)) continue;
        yield { abs, rel: relative(root, abs) };
        yielded += 1;
        if (yielded >= MAX_FILES_PER_RUN) return;
      }
    }
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid-body', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 400 },
    );
  }

  const ws = await getWorkspace(body.workspaceId).catch(() => null);
  if (!ws) {
    return NextResponse.json({ error: 'workspace-not-found' }, { status: 404 });
  }
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (ws.sensitivity === 'high') {
    return NextResponse.json(
      { error: 'high-sensitivity-block', hint: 'High-Sensitivity-Workspaces werden nie indiziert.' },
      { status: 403 },
    );
  }

  const sources: IndexableSource[] = [];

  if ((body.sources === 'all' || body.sources === 'files') && ws.path && existsSync(ws.path)) {
    for (const file of walkFiles(ws.path)) {
      try {
        const text = readFileSync(file.abs, 'utf8');
        if (text.length === 0) continue;
        sources.push({
          workspaceId: ws.id,
          sourceType: 'file',
          sourceId: file.rel,
          sourceVersion: Math.floor(statSync(file.abs).mtimeMs),
          text,
          sensitivity: 'low',
        });
      } catch {
        /* skip */
      }
    }
  }

  if (body.sources === 'all' || body.sources === 'chat') {
    const db = getDb();
    const rows = db
      .select({
        id: events.id,
        payload: events.payload,
        sensitivity: events.sensitivity,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(
        and(
          eq(events.segmentId, ws.id),
          eq(events.eventType, 'chat_message_completed'),
        ),
      )
      .orderBy(desc(events.createdAt))
      .limit(body.maxChat)
      .all();
    for (const row of rows) {
      if (row.sensitivity === 'high') continue;
      const payload = row.payload as { content?: string };
      if (typeof payload.content !== 'string' || payload.content.length < 30) continue;
      sources.push({
        workspaceId: ws.id,
        sourceType: 'chat',
        sourceId: row.id,
        sourceVersion: row.createdAt,
        text: payload.content,
        sensitivity: 'low',
      });
    }
  }

  if (sources.length === 0) {
    return NextResponse.json({ ok: false, indexed: 0, hint: 'no-sources' });
  }

  // Synchron — bei großen Workspaces vom UI Background-Toast handhaben.
  const result = await indexBatch(sources);
  return NextResponse.json({
    ok: true,
    workspaceId: ws.id,
    indexed: result.indexed,
    skipped: result.skipped,
    failed: result.failed,
    reasons: result.reasons.slice(0, 20),
  });
}
