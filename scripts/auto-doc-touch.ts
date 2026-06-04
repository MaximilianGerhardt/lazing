#!/usr/bin/env -S npx tsx
/**
 * scripts/auto-doc-touch.ts
 *
 * Auto-doc update on every commit. User request 2026-05-03 (verbatim):
 *  "wenn du änderungen machst, dass die claude.md und alle dateien
 *   automatisch sozusagen bewusst gemacht werden"
 *
 * Called from .git/hooks/post-commit. Reads the last commit
 * via `git log -1` and:
 *   1. Appends a line to docs/CHANGELOG-AUTO.md (append-only).
 *   2. Updates the managed section in CLAUDE.md between
 *      <!-- AUTO-RECENT-CHANGES-START --> ... <!-- AUTO-RECENT-CHANGES-END -->
 *      with the last 10 commits.
 *   3. Optional: writes a system event into the event log via /api/events/emit
 *      (best-effort, fail-silent).
 *
 * NEVER auto-commit from this hook (it would build an infinite loop).
 * The hook writes the files; the next human commit commits them along.
 *
 * Idempotent: skip duplicate invocations for the same commit hash.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const REPO_ROOT = process.env.LAZYOS_REPO_ROOT ?? process.cwd();
const CHANGELOG_PATH = `${REPO_ROOT}/docs/CHANGELOG-AUTO.md`;
const CLAUDE_MD_PATH = `${REPO_ROOT}/CLAUDE.md`;
const RECENT_LIMIT = 10;
const MARKER_START = '<!-- AUTO-RECENT-CHANGES-START -->';
const MARKER_END = '<!-- AUTO-RECENT-CHANGES-END -->';

interface CommitInfo {
  sha: string;
  shaShort: string;
  isoDate: string;
  subject: string;
  body: string;
  files: string[];
}

function gitInfo(ref: string): CommitInfo {
  const sha = execSync(`git -C ${REPO_ROOT} rev-parse ${ref}`).toString().trim();
  const shaShort = sha.slice(0, 7);
  const isoDate = execSync(`git -C ${REPO_ROOT} log -1 --format=%cI ${ref}`)
    .toString()
    .trim();
  const subject = execSync(`git -C ${REPO_ROOT} log -1 --format=%s ${ref}`)
    .toString()
    .trim();
  const body = execSync(`git -C ${REPO_ROOT} log -1 --format=%b ${ref}`)
    .toString()
    .trim();
  const files = execSync(
    `git -C ${REPO_ROOT} log -1 --name-only --format= ${ref}`,
  )
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { sha, shaShort, isoDate, subject, body, files };
}

function ensureFile(path: string, initial: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, initial, 'utf8');
}

function appendChangelog(info: CommitInfo): boolean {
  ensureFile(
    CHANGELOG_PATH,
    `# CHANGELOG (auto)\n\nAutomatisch generiert von .git/hooks/post-commit via scripts/auto-doc-touch.ts.\nKein manuelles Editieren — Append-only.\n\n`,
  );
  const existing = readFileSync(CHANGELOG_PATH, 'utf8');
  if (existing.includes(`[${info.shaShort}]`)) {
    return false; // Idempotent: commit already present.
  }
  const filesPreview =
    info.files.length === 0
      ? ''
      : info.files.length <= 4
        ? ` · files: ${info.files.join(', ')}`
        : ` · files: ${info.files.slice(0, 4).join(', ')} (+${info.files.length - 4})`;
  const line = `- ${info.isoDate} [${info.shaShort}] ${info.subject}${filesPreview}\n`;
  writeFileSync(CHANGELOG_PATH, existing + line, 'utf8');
  return true;
}

function recentCommits(): CommitInfo[] {
  // Pipes in --format break without quoting (the shell interprets them). We
  // use an ASCII unit separator (US, 0x1f) as the delimiter — it practically
  // never appears in commit subjects.
  const SEP = '\x1f';
  const log = execSync(
    `git -C ${REPO_ROOT} log -n ${RECENT_LIMIT} --format='%H${SEP}%cI${SEP}%s'`,
  )
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  return log.map((line) => {
    const [sha, isoDate, ...rest] = line.split(SEP);
    const subject = rest.join(SEP);
    return {
      sha,
      shaShort: sha.slice(0, 7),
      isoDate,
      subject,
      body: '',
      files: [],
    };
  });
}

function updateClaudeRecent(): boolean {
  if (!existsSync(CLAUDE_MD_PATH)) {
    return false; // No CLAUDE.md in the repo root → nothing to update.
  }
  const content = readFileSync(CLAUDE_MD_PATH, 'utf8');
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  const recents = recentCommits();
  const list = recents
    .map((c) => `- ${c.isoDate.slice(0, 10)} [${c.shaShort}] ${c.subject}`)
    .join('\n');
  const block = `${MARKER_START}\n## RECENT-CHANGES (auto)\n\n${list}\n${MARKER_END}`;

  let next: string;
  if (startIdx === -1 || endIdx === -1) {
    // Markers missing → append at the end.
    next = content.trimEnd() + '\n\n' + block + '\n';
  } else {
    next =
      content.slice(0, startIdx) +
      block +
      content.slice(endIdx + MARKER_END.length);
  }
  if (next === content) return false;
  writeFileSync(CLAUDE_MD_PATH, next, 'utf8');
  return true;
}

function emitEvent(info: CommitInfo): void {
  // Best-effort: HTTP POST against /api/events/emit (local lazyos-web).
  // Fail-silent — if the web app is not running, that is fine.
  try {
    const url = process.env.LAZYOS_EMIT_URL ?? 'http://127.0.0.1:4200/api/events/emit';
    const payload = JSON.stringify({
      kind: 'system.commit',
      segment: '@system',
      data: {
        sha: info.shaShort,
        subject: info.subject,
        files: info.files.slice(0, 8),
        ts: info.isoDate,
      },
    });
    execSync(
      `curl -sS -m 3 -o /dev/null -X POST -H 'content-type: application/json' --data ${JSON.stringify(payload)} ${url}`,
      { stdio: 'ignore' },
    );
  } catch {
    /* ignore */
  }
}

function main(): void {
  try {
    const ref = process.argv[2] ?? 'HEAD';
    const info = gitInfo(ref);
    const changelogChanged = appendChangelog(info);
    const claudeChanged = updateClaudeRecent();
    if (changelogChanged || claudeChanged) {
      emitEvent(info);
      // eslint-disable-next-line no-console
      console.log(
        `[auto-doc-touch] sha=${info.shaShort} changelog=${changelogChanged} claude=${claudeChanged}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[auto-doc-touch] failed (non-fatal):', err);
    // Hook exits with 0 because auto-doc never blocks a commit.
    process.exit(0);
  }
}

main();
