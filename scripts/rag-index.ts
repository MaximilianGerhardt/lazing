/**
 * RAG-Indexer-CLI (Sprint 2 / Strang B, 2026-04-30).
 *
 * Indexiert einen Workspace inkl. Files + Chat-History + Tickets +
 * Work-Products. Idempotent (re-index überschreibt alte Chunks pro Source).
 *
 * Privacy-Gate (Defense-in-Depth):
 *   - Workspaces mit sensitivity='high' (z.B. 'private') werden komplett
 *     übersprungen außer mit `--include-high` Flag (bewusste Opt-in).
 *   - Pro Source: high-sensitivity-Events/Chunks bleiben aus dem Index.
 *
 * Usage:
 *   pnpm tsx scripts/rag-index.ts --workspace=lazyos
 *   pnpm tsx scripts/rag-index.ts --workspace=demo-fitness --dry-run
 *   pnpm tsx scripts/rag-index.ts --workspace=lazyos --skip-files
 *
 * Background-Run via systemd-timer (Sprint 2 Welle 3 follow-up):
 *   /etc/systemd/system/lazyos-rag-indexer.timer (alle 30 min)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { existsSync } from 'node:fs';

import { getDb } from '@/db/client';
import { events } from '@/db/schema/events';
import { getWorkspace } from '@/lib/workspaces';
import { eq, and, desc } from 'drizzle-orm';
import { indexBatch, type IndexableSource } from '@/lib/rag/indexer';

const FILE_EXT_WHITELIST = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.md', '.mdx', '.txt',
  '.sql', '.json', '.yaml', '.yml',
  '.css', '.scss',
  '.py', '.rb', '.go', '.rs',
]);

const FILE_DIR_BLACKLIST = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'out', 'coverage', '.turbo', '.vercel', '.expo', '.android', '.ios',
  '__pycache__', '.venv', 'venv', '.pnpm-store',
]);

const MAX_FILE_BYTES = 200 * 1024;

interface CliArgs {
  workspaceId: string;
  dryRun: boolean;
  skipFiles: boolean;
  skipChat: boolean;
  includeHigh: boolean;
  maxChat: number;
}

function parseArgs(): CliArgs {
  const args: Partial<CliArgs> = { dryRun: false, skipFiles: false, skipChat: false, includeHigh: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--workspace=')) args.workspaceId = a.slice('--workspace='.length);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--skip-files') args.skipFiles = true;
    else if (a === '--skip-chat') args.skipChat = true;
    else if (a === '--include-high') args.includeHigh = true;
    else if (a.startsWith('--max-chat=')) args.maxChat = Number(a.slice('--max-chat='.length));
  }
  if (!args.workspaceId) {
    console.error('Usage: pnpm tsx scripts/rag-index.ts --workspace=<id> [--dry-run] [--skip-files] [--skip-chat]');
    process.exit(2);
  }
  return {
    workspaceId: args.workspaceId,
    dryRun: args.dryRun!,
    skipFiles: args.skipFiles!,
    skipChat: args.skipChat!,
    includeHigh: args.includeHigh!,
    maxChat: args.maxChat ?? 500,
  };
}

function* walkFiles(root: string): Generator<{ abs: string; rel: string; size: number }> {
  const dirs: string[] = [root];
  while (dirs.length > 0) {
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
      } else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) continue;
        const ext = extname(name).toLowerCase();
        if (!FILE_EXT_WHITELIST.has(ext)) continue;
        yield { abs, rel: relative(root, abs), size: st.size };
      }
    }
  }
}

async function collectFileSources(
  workspaceId: string,
  workspacePath: string,
): Promise<IndexableSource[]> {
  if (!existsSync(workspacePath)) {
    console.warn(`[rag-index] workspace path missing: ${workspacePath}`);
    return [];
  }
  const out: IndexableSource[] = [];
  for (const file of walkFiles(workspacePath)) {
    let text: string;
    try {
      text = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    out.push({
      workspaceId,
      sourceType: 'file',
      sourceId: file.rel,
      sourceVersion: Math.floor(statSync(file.abs).mtimeMs),
      text,
      sensitivity: 'low',
    });
  }
  return out;
}

async function collectChatSources(
  workspaceId: string,
  limit: number,
): Promise<IndexableSource[]> {
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
        eq(events.segmentId, workspaceId),
        eq(events.eventType, 'chat_message_completed'),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(limit)
    .all();

  const out: IndexableSource[] = [];
  for (const row of rows) {
    if (row.sensitivity === 'high') continue;
    const payload = row.payload as { content?: string; role?: string };
    if (typeof payload.content !== 'string' || payload.content.length < 30) continue;
    out.push({
      workspaceId,
      sourceType: 'chat',
      sourceId: row.id,
      sourceVersion: row.createdAt,
      text: payload.content,
      sensitivity: (row.sensitivity as 'low' | 'med' | 'high') ?? 'low',
    });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const ws = await getWorkspace(args.workspaceId).catch(() => null);
  if (!ws) {
    console.error(`[rag-index] workspace not found: ${args.workspaceId}`);
    process.exit(3);
  }

  if (ws.sensitivity === 'high' && !args.includeHigh) {
    console.log(`[rag-index] SKIP workspace ${ws.id} (sensitivity=high). Use --include-high to override.`);
    process.exit(0);
  }

  console.log(`[rag-index] workspace=${ws.id} path=${ws.path} sensitivity=${ws.sensitivity}`);

  const sources: IndexableSource[] = [];
  if (!args.skipFiles && ws.path) {
    const fileSources = await collectFileSources(ws.id, ws.path);
    console.log(`[rag-index] collected ${fileSources.length} file-sources`);
    sources.push(...fileSources);
  }
  if (!args.skipChat) {
    const chatSources = await collectChatSources(ws.id, args.maxChat);
    console.log(`[rag-index] collected ${chatSources.length} chat-sources (limit ${args.maxChat})`);
    sources.push(...chatSources);
  }

  if (args.dryRun) {
    console.log(`[rag-index] DRY-RUN: would index ${sources.length} sources`);
    for (const s of sources.slice(0, 5)) {
      console.log(`  - ${s.sourceType}/${s.sourceId} (${s.text.length} chars)`);
    }
    if (sources.length > 5) console.log(`  ... +${sources.length - 5} more`);
    process.exit(0);
  }

  console.log(`[rag-index] indexing ${sources.length} sources …`);
  const result = await indexBatch(sources);
  console.log(`[rag-index] DONE: indexed=${result.indexed} skipped=${result.skipped} failed=${result.failed}`);
  if (result.reasons.length > 0) {
    console.log('[rag-index] reasons (first 10):');
    for (const r of result.reasons.slice(0, 10)) console.log('  -', r);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[rag-index] FATAL:', err);
  process.exit(1);
});
