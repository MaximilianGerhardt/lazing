// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-PERM-04a Pattern-Derive (BUG-FIX-1 must-fix #2)
// Authority: modules/W1/M-PERM-04a/CUTOVER-SCRIPT-SPEC.md §2.5
//
// 4 Cluster-Strategien: pfad-prefix-cluster · command-name+first-arg-prefix ·
// host-aggregation · tool-list-set.

import {
  POLICY_TOOL_CLASS_MAP,
  type AuditToolClass,
  type ToolClass,
} from './tool-class-map';

export interface AuditRow {
  workspace_id: string;
  tool_class: string;
  tool_name: string;
  args_json: string;
  decision: 'allow' | 'deny';
  created_at: string;
}

export interface DerivedPattern {
  tool_class: ToolClass;
  allowed_pattern: string;
  sample_count: number;
  sample_audit_rows: number[];
  ttl_suggestion: number | null;
}

export interface DeriveOptions {
  noise_floor?: number;
  workspace_cwd?: string;
}

function policyClassOf(auditClass: string): ToolClass | null {
  const mapped =
    POLICY_TOOL_CLASS_MAP[auditClass as AuditToolClass] ?? null;
  return mapped;
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === '') return '';
  }
  return prefix;
}

export function clusterFsReadByPathPrefix(
  rows: AuditRow[],
  cwd?: string,
): DerivedPattern[] {
  if (rows.length === 0) return [];
  const paths: string[] = [];
  const rowIds: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const args = JSON.parse(r.args_json) as { path?: string };
      if (args.path) {
        paths.push(args.path);
        rowIds.push(i);
      }
    } catch {
      /* skip */
    }
  }
  if (paths.length === 0) return [];
  // Find common-prefix; widen to last `/`.
  let prefix = commonPrefix(paths);
  const lastSlash = prefix.lastIndexOf('/');
  if (lastSlash > 0) prefix = prefix.slice(0, lastSlash + 1);
  const pattern = prefix ? `Read(${prefix}**)` : `Read(${cwd ?? './'}**)`;
  return [
    {
      tool_class: 'fs-read',
      allowed_pattern: pattern,
      sample_count: paths.length,
      sample_audit_rows: rowIds,
      ttl_suggestion: null,
    },
  ];
}

export function clusterShellByCommandAndFirstArg(
  rows: AuditRow[],
): DerivedPattern[] {
  if (rows.length === 0) return [];
  // Group by `<command> <first-arg>` prefix
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const args = JSON.parse(r.args_json) as { command?: string };
      if (!args.command) continue;
      const parts = args.command.trim().split(/\s+/);
      const key = parts.slice(0, 2).join(' ');
      const arr = buckets.get(key) ?? [];
      arr.push(i);
      buckets.set(key, arr);
    } catch {
      /* skip */
    }
  }
  const out: DerivedPattern[] = [];
  for (const [key, ids] of buckets.entries()) {
    out.push({
      tool_class: 'shell',
      allowed_pattern: `Bash(${key}*)`,
      sample_count: ids.length,
      sample_audit_rows: ids,
      ttl_suggestion: null,
    });
  }
  return out;
}

export function clusterNetworkByHost(rows: AuditRow[]): DerivedPattern[] {
  if (rows.length === 0) return [];
  const hosts = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const args = JSON.parse(r.args_json) as { url?: string };
      if (!args.url) continue;
      const m = /^https?:\/\/([^/]+)/.exec(args.url);
      if (!m) continue;
      const host = m[1];
      const arr = hosts.get(host) ?? [];
      arr.push(i);
      hosts.set(host, arr);
    } catch {
      /* skip */
    }
  }
  const out: DerivedPattern[] = [];
  for (const [host, ids] of hosts.entries()) {
    out.push({
      tool_class: 'network',
      allowed_pattern: `Network(${host})`,
      sample_count: ids.length,
      sample_audit_rows: ids,
      ttl_suggestion: 3600,
    });
  }
  return out;
}

export function clusterClaudeCliSubspawnByToolList(
  rows: AuditRow[],
): DerivedPattern[] {
  if (rows.length === 0) return [];
  const sets = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const args = JSON.parse(r.args_json) as { allowed_tools?: string[] };
      if (!args.allowed_tools) continue;
      const key = [...args.allowed_tools].sort().join('+');
      const arr = sets.get(key) ?? [];
      arr.push(i);
      sets.set(key, arr);
    } catch {
      /* skip */
    }
  }
  const out: DerivedPattern[] = [];
  for (const [toolList, ids] of sets.entries()) {
    out.push({
      tool_class: 'claude-cli-subspawn',
      allowed_pattern: `Spawn(${toolList})`,
      sample_count: ids.length,
      sample_audit_rows: ids,
      ttl_suggestion: null,
    });
  }
  return out;
}

export function derivePatternsForWorkspace(
  _workspaceId: string,
  rows: AuditRow[],
  opts: DeriveOptions = {},
): DerivedPattern[] {
  const noise = opts.noise_floor ?? 2;
  const byPolicy = new Map<ToolClass, AuditRow[]>();
  for (const r of rows) {
    const cls = policyClassOf(r.tool_class);
    if (!cls) continue;
    const arr = byPolicy.get(cls) ?? [];
    arr.push(r);
    byPolicy.set(cls, arr);
  }
  const patterns: DerivedPattern[] = [];
  for (const [cls, rs] of byPolicy.entries()) {
    let derived: DerivedPattern[] = [];
    switch (cls) {
      case 'fs-read':
        derived = clusterFsReadByPathPrefix(rs, opts.workspace_cwd);
        break;
      case 'shell':
        derived = clusterShellByCommandAndFirstArg(rs);
        break;
      case 'network':
        derived = clusterNetworkByHost(rs);
        break;
      case 'claude-cli-subspawn':
        derived = clusterClaudeCliSubspawnByToolList(rs);
        break;
      default:
        // For unsupported classes (fs-write/git/ollama/db) use first command-name
        derived = clusterShellByCommandAndFirstArg(rs).map((d) => ({
          ...d,
          tool_class: cls,
        }));
    }
    patterns.push(...derived.filter((d) => d.sample_count >= noise));
  }
  // Determinism: sort by tool_class then allowed_pattern.
  patterns.sort((a, b) => {
    if (a.tool_class !== b.tool_class)
      return a.tool_class < b.tool_class ? -1 : 1;
    return a.allowed_pattern < b.allowed_pattern ? -1 : 1;
  });
  return patterns;
}
