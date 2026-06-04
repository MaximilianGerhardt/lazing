/**
 * GET /api/chat/usage?workspaceId=X
 *
 * Liefert Metadaten des letzten Chat-Turns im Workspace:
 *   - model               (aus agent-server /health)
 *   - sessionId           (aktive UUID)
 *   - turnCount
 *   - lastInputTokens     (aus JSONL "usage.input_tokens" im letzten result-frame)
 *   - lastOutputTokens    (usage.output_tokens)
 *   - lastCacheReadTokens (usage.cache_read_input_tokens)
 *   - contextTotal        (Summe aller input-related Tokens im letzten Turn)
 *   - contextWindow       (200_000 für Opus 4.7 1M-Context ist 1_000_000)
 *   - contextFillPct      (0..100)
 *
 * Read-only. Greift auf ~/.claude/projects/<slug>/<uuid>.jsonl zu.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { projectsRoot } from '@/lib/workspaces/projects-root';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HOME = process.env.HOME ?? os.homedir();
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
// claude-code slugifies the cwd by replacing `/` with `-` (leading `-`).
const PROJECTS_DIR_PREFIX =
  projectsRoot().replace(/\/+$/, '').replace(/\//g, '-') + '-';

// Opus 4.7 läuft standardmäßig mit 1M-Context in lazyOS (siehe CLAUDE.md —
// "Default-Modell: Opus 4.7 mit 1M Context"). Für andere Modelle 200k.
function contextWindowFor(model: string): number {
  if (model.includes('opus-4-8') || model.includes('opus-4-7') || model.includes('1m') || model.includes('[1m]')) {
    return 1_000_000;
  }
  return 200_000;
}

function slugForWorkspace(workspaceId: string): string {
  // claude-code turns `<projectsRoot>/<id>` into `<projects-root-slug>-<id>`.
  // root / tmp / home are special pseudo-workspaces.
  if (workspaceId === '(root)') return '-root';
  if (workspaceId === '(tmp)') return '-tmp';
  if (workspaceId === '(home)') {
    return HOME.replace(/\/+$/, '').replace(/\//g, '-');
  }
  return `${PROJECTS_DIR_PREFIX}${workspaceId}`;
}

interface UsagePayload {
  workspaceId: string;
  sessionId: string | null;
  model: string;
  turnCount: number;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastCacheReadTokens: number;
  contextTotal: number;
  contextWindow: number;
  contextFillPct: number;
  agentReachable: boolean;
  claudeAvailable: boolean;
  maxPlan: boolean;
}

async function fetchAgentHealth(): Promise<{ model?: string; claudeAvailable?: boolean; maxPlan?: boolean; activeSessions?: Array<{ workspaceId: string; turnCount?: number }> }> {
  const base = (process.env.LAZYOS_AGENT_URL ?? 'http://127.0.0.1:4201').replace(/\/+$/, '');
  try {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 3_000);
    const resp = await fetch(`${base}/health`, { signal: ctl.signal });
    clearTimeout(timeout);
    if (!resp.ok) return {};
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function tailFile(filePath: string, bytes: number): string {
  const stat = fs.statSync(filePath);
  const readSize = Math.min(stat.size, bytes);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(readSize);
  try {
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8');
}

function extractLastUsage(filePath: string): { input: number; output: number; cacheRead: number } {
  const tail = tailFile(filePath, 128 * 1024);
  const lines = tail.split('\n').filter((l) => l.trim().length > 0);
  // Parse from end to find last result-frame with usage
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]) as { type?: string; message?: unknown; usage?: unknown };
      // result frames have message.usage sometimes
      const msg = (obj.message ?? obj) as Record<string, unknown>;
      const usage = (msg.usage ?? obj.usage) as Record<string, unknown> | undefined;
      if (usage && typeof usage === 'object') {
        const inT = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        const outT = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
        const cacheT = typeof usage.cache_read_input_tokens === 'number'
          ? usage.cache_read_input_tokens
          : 0;
        if (inT > 0 || outT > 0 || cacheT > 0) {
          return { input: inT, output: outT, cacheRead: cacheT };
        }
      }
    } catch {
      // skip malformed
    }
  }
  return { input: 0, output: 0, cacheRead: 0 };
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId') ?? 'lazyos';

  const health = await fetchAgentHealth();
  const model = (health.model ?? 'claude-opus-4-8').toString();
  const agentReachable = Boolean(health.claudeAvailable !== undefined);
  const claudeAvailable = Boolean(health.claudeAvailable);
  const maxPlan = Boolean(health.maxPlan);
  const activeSession = Array.isArray(health.activeSessions)
    ? health.activeSessions.find((s) => s.workspaceId === workspaceId)
    : undefined;

  let sessionId: string | null = null;
  let turnCount = activeSession?.turnCount ?? 0;
  let lastInput = 0;
  let lastOutput = 0;
  let lastCacheRead = 0;

  // Find active session-uuid for this workspace via filesystem + mtime
  const slug = slugForWorkspace(workspaceId);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, slug);
  try {
    if (fs.existsSync(projectDir)) {
      const files = fs
        .readdirSync(projectDir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
        .map((f) => {
          const p = path.join(projectDir, f.name);
          const stat = fs.statSync(p);
          return { name: f.name, mtime: stat.mtimeMs, path: p };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        sessionId = files[0].name.replace(/\.jsonl$/, '');
        const usage = extractLastUsage(files[0].path);
        lastInput = usage.input;
        lastOutput = usage.output;
        lastCacheRead = usage.cacheRead;
      }
    }
  } catch {
    // non-fatal
  }

  const contextWindow = contextWindowFor(model);
  const contextTotal = lastInput + lastCacheRead;
  const contextFillPct = Math.min(100, Math.round((contextTotal / contextWindow) * 100));

  const payload: UsagePayload = {
    workspaceId,
    sessionId,
    model,
    turnCount,
    lastInputTokens: lastInput,
    lastOutputTokens: lastOutput,
    lastCacheReadTokens: lastCacheRead,
    contextTotal,
    contextWindow,
    contextFillPct,
    agentReachable,
    claudeAvailable,
    maxPlan,
  };

  return NextResponse.json(payload, {
    headers: { 'cache-control': 'no-store' },
  });
}
