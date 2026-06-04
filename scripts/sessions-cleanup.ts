/**
 * scripts/sessions-cleanup.ts — Phase Maintenance (2026-04-29).
 *
 * Räumt alte `.jsonl`-Files aus `~/.claude/projects/` auf. Claude-Code-CLI
 * persistiert jeden Spawn als eigene Session-Datei und macht selber kein
 * Cleanup. Bei Multi-Tier-Workstreams entstehen viele Files (auf einer
 * Dev-VM heute: 10k+ Files / 1.8 GB).
 *
 * Default-Policy:
 *   - Lösche `.jsonl`-Files älter als 30 Tage
 *   - Behalte mindestens N=50 Files pro Projekt-Folder (Audit-Floor)
 *   - Dry-Run als Default; --apply löscht
 *
 * Usage:
 *   pnpm tsx scripts/sessions-cleanup.ts                # dry-run
 *   pnpm tsx scripts/sessions-cleanup.ts --apply        # echte Löschung
 *   pnpm tsx scripts/sessions-cleanup.ts --apply --days=14
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface CleanupArgs {
  apply: boolean;
  daysThreshold: number;
  keepFloor: number;
  baseDir: string;
}

function parseArgs(): CleanupArgs {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const daysArg = args.find((a) => a.startsWith('--days='));
  const days = daysArg ? parseInt(daysArg.split('=')[1] ?? '30', 10) : 30;
  const keepArg = args.find((a) => a.startsWith('--keep='));
  const keep = keepArg ? parseInt(keepArg.split('=')[1] ?? '50', 10) : 50;
  return {
    apply,
    daysThreshold: Math.max(1, days),
    keepFloor: Math.max(0, keep),
    baseDir: join(homedir(), '.claude', 'projects'),
  };
}

interface FileEntry {
  path: string;
  mtime: number;
  sizeBytes: number;
}

function listJsonlFiles(dir: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let inner: string[] = [];
  try {
    inner = readdirSync(dir);
  } catch {
    return entries;
  }
  for (const name of inner) {
    if (!name.endsWith('.jsonl')) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      entries.push({
        path: p,
        mtime: st.mtimeMs,
        sizeBytes: st.size,
      });
    } catch {
      /* ignore */
    }
  }
  return entries;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function main(): void {
  const args = parseArgs();
  console.log(
    `[sessions-cleanup] base=${args.baseDir} days=${args.daysThreshold} keepFloor=${args.keepFloor} apply=${args.apply}`,
  );

  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(args.baseDir).filter((d) => {
      try {
        return statSync(join(args.baseDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch (err) {
    console.error('[sessions-cleanup] base-dir not readable:', err);
    process.exit(1);
  }

  const cutoffMs = Date.now() - args.daysThreshold * 24 * 60 * 60 * 1000;
  let totalScanned = 0;
  let totalCandidates = 0;
  let totalApplied = 0;
  let totalBytesFreed = 0;

  for (const projName of projectDirs) {
    const projPath = join(args.baseDir, projName);
    const files = listJsonlFiles(projPath);
    if (files.length === 0) continue;
    totalScanned += files.length;

    // Sortiere nach mtime DESC — neueste zuerst.
    files.sort((a, b) => b.mtime - a.mtime);
    const keep = files.slice(0, args.keepFloor);
    const candidates = files.slice(args.keepFloor);

    let projDeleted = 0;
    let projBytes = 0;
    for (const f of candidates) {
      if (f.mtime > cutoffMs) continue; // jünger als threshold → behalten
      totalCandidates += 1;
      projDeleted += 1;
      projBytes += f.sizeBytes;
      if (args.apply) {
        try {
          unlinkSync(f.path);
          totalApplied += 1;
          totalBytesFreed += f.sizeBytes;
        } catch (err) {
          console.warn(
            `[sessions-cleanup] delete failed: ${f.path}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    if (projDeleted > 0) {
      console.log(
        `  ${projName}: ${projDeleted} files / ${fmtBytes(projBytes)}` +
          (args.apply ? ' [DELETED]' : ' [DRY-RUN]') +
          ` (kept ${keep.length})`,
      );
    }
  }

  console.log('');
  console.log(
    `[sessions-cleanup] scanned=${totalScanned} candidates=${totalCandidates} ` +
      `applied=${totalApplied} freed=${fmtBytes(totalBytesFreed)}`,
  );
  if (!args.apply && totalCandidates > 0) {
    console.log('[sessions-cleanup] DRY-RUN — re-run with --apply to actually delete.');
  }
}

main();
