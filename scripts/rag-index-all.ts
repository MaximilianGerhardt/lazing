/**
 * RAG auto-indexer for all non-archived workspaces (except high-sensitivity).
 * Runs via systemd timer every 30 min.
 *
 * Loop guard: indexBatch has a 60s recursion debounce + circuit breaker.
 * Workspaces are indexed serially (not in parallel) — otherwise an ONNX memory spike.
 */

import { getDb } from '@/db/client';
import { workspaces } from '@/db/schema/workspaces';
import { eq, and, ne } from 'drizzle-orm';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { events } from '@/db/schema/events';
import { desc } from 'drizzle-orm';
import { indexBatch, type IndexableSource } from '@/lib/rag/indexer';

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
const MAX_FILES_PER_WS = 1500;
const MAX_CHAT_PER_WS = 200;

function* walkFiles(root: string): Generator<{ abs: string; rel: string }> {
  const dirs: string[] = [root];
  let yielded = 0;
  while (dirs.length > 0 && yielded < MAX_FILES_PER_WS) {
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
      if (st.isDirectory()) dirs.push(abs);
      else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
        const ext = extname(name).toLowerCase();
        if (!FILE_EXT_WHITELIST.has(ext)) continue;
        yield { abs, rel: relative(root, abs) };
        yielded += 1;
        if (yielded >= MAX_FILES_PER_WS) return;
      }
    }
  }
}

async function indexWorkspace(wsId: string, wsPath: string | null): Promise<void> {
  const sources: IndexableSource[] = [];

  if (wsPath && existsSync(wsPath)) {
    for (const file of walkFiles(wsPath)) {
      try {
        const text = readFileSync(file.abs, 'utf8');
        if (text.length === 0) continue;
        sources.push({
          workspaceId: wsId,
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

  const db = getDb();
  const chatRows = db
    .select({
      id: events.id,
      payload: events.payload,
      sensitivity: events.sensitivity,
      createdAt: events.createdAt,
    })
    .from(events)
    .where(
      and(
        eq(events.segmentId, wsId),
        eq(events.eventType, 'chat_message_completed'),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(MAX_CHAT_PER_WS)
    .all();

  for (const row of chatRows) {
    if (row.sensitivity === 'high') continue;
    const payload = row.payload as { content?: string };
    if (typeof payload.content !== 'string' || payload.content.length < 30) continue;
    sources.push({
      workspaceId: wsId,
      sourceType: 'chat',
      sourceId: row.id,
      sourceVersion: row.createdAt,
      text: payload.content,
      sensitivity: 'low',
    });
  }

  if (sources.length === 0) {
    console.log(`[auto-index] ${wsId}: no sources`);
    return;
  }

  const result = await indexBatch(sources);
  console.log(
    `[auto-index] ${wsId}: indexed=${result.indexed} skipped=${result.skipped} failed=${result.failed} reasons=${result.reasons.length}`,
  );
}

async function main(): Promise<void> {
  const started = Date.now();
  const db = getDb();
  const allWs = db
    .select({
      id: workspaces.id,
      path: workspaces.path,
      sensitivity: workspaces.sensitivity,
      archived: workspaces.archived,
    })
    .from(workspaces)
    .where(ne(workspaces.sensitivity, 'high'))
    .all()
    .filter((w) => !w.archived);

  console.log(`[auto-index] ${allWs.length} workspaces (low/med sensitivity)`);
  for (const ws of allWs) {
    try {
      await indexWorkspace(ws.id, ws.path);
    } catch (err) {
      console.error(`[auto-index] ${ws.id} fatal:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[auto-index] done in ${Math.round((Date.now() - started) / 1000)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[auto-index] FATAL:', err);
  process.exit(1);
});
