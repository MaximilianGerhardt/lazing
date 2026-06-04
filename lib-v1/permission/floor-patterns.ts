// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// Floor-class detection patterns (M6 §4.1 verbatim).
// Frozen — drift-tested.

export type FloorClass =
  | 'fs-destroy-root'
  | 'db-system-tables'
  | 'audit-tampering'
  | 'secret-read';

export const TWO_FACTOR_OVERRIDE_PERMIT_SET: ReadonlySet<FloorClass> = new Set([
  'secret-read',
]);

export interface FloorPattern {
  tool: 'Bash' | 'Edit' | 'Write' | 'Read' | 'DB';
  regex?: RegExp;
  pathRegex?: RegExp;
  contentRegex?: RegExp;
}

export const FLOOR_DETECT_PATTERNS: Readonly<
  Record<FloorClass, ReadonlyArray<FloorPattern>>
> = Object.freeze({
  'fs-destroy-root': [
    { tool: 'Bash' as const, regex: /\brm\s+-rf?\s+\/(\s|$)/ },
    { tool: 'Bash' as const, regex: /\bfind\b.*-delete\b/ },
    { tool: 'Bash' as const, regex: /:\(\)\{\s*:\|\s*:&\s*\}\s*;\s*:/ },
  ] as ReadonlyArray<FloorPattern>,
  'db-system-tables': [
    { tool: 'DB' as const, regex: /\bDROP\s+TABLE\b/i },
    { tool: 'DB' as const, regex: /\bTRUNCATE\b/i },
    { tool: 'DB' as const, regex: /\bALTER\s+TABLE\s+lazyos_/i },
  ] as ReadonlyArray<FloorPattern>,
  'audit-tampering': [
    { tool: 'Bash' as const, regex: /sqlite3.*UPDATE\s+lazyos_\w*_audit/i },
    { tool: 'Bash' as const, regex: /sqlite3.*DELETE\s+FROM\s+lazyos_\w*_audit/i },
    { tool: 'Bash' as const, regex: /\bDROP\s+TRIGGER\b/i },
    { tool: 'Bash' as const, regex: /\bPRAGMA\s+writable_schema\s*=\s*1\b/i },
    {
      tool: 'Edit' as const,
      pathRegex: /db\/migrations\/.*\.sql$/,
      contentRegex: /lazyos_\w*_audit/i,
    },
    {
      tool: 'Write' as const,
      pathRegex: /db\/migrations\/.*\.sql$/,
      contentRegex: /lazyos_\w*_audit/i,
    },
    { tool: 'Write' as const, pathRegex: /\.(sqlite|sqlite3|db)(-journal|-wal|-shm)?$/i },
    { tool: 'Edit' as const, pathRegex: /\.(sqlite|sqlite3|db)(-journal|-wal|-shm)?$/i },
    {
      tool: 'Bash' as const,
      regex: /\b(cat|dd|tee|cp|mv)\b.*\.(sqlite|sqlite3|db)(-journal|-wal|-shm)\b/i,
    },
    { tool: 'Bash' as const, regex: /\bVACUUM\s+INTO\b/i },
  ] as ReadonlyArray<FloorPattern>,
  'secret-read': [
    { tool: 'Read' as const, pathRegex: /\.ssh\/id_/ },
    { tool: 'Read' as const, pathRegex: /\.config\/[^/]+\/credentials/ },
    { tool: 'Bash' as const, regex: /\bsecurity\s+find-generic-password\b/ },
  ] as ReadonlyArray<FloorPattern>,
});

/**
 * Detect the floor-class of a given tool-pattern; returns null if none.
 *
 * `toolName` is the tool name (Bash/Edit/Write/Read/DB).
 * `payload` is the verbatim command/SQL body.
 * `workspacePath` is the caller cwd for relative-path matching.
 * `fileTargetPath` is required for Edit/Write classification.
 */
export function detectFloorClass(
  toolName: string,
  payload: string,
  _workspacePath?: string,
  fileTargetPath?: string,
): FloorClass | null {
  for (const cls of Object.keys(FLOOR_DETECT_PATTERNS) as FloorClass[]) {
    for (const p of FLOOR_DETECT_PATTERNS[cls]) {
      if (p.tool !== toolName) continue;
      // Bash/DB/Read — check payload
      if (p.regex && p.regex.test(payload)) return cls;
      // Edit/Write — pathRegex must match target; contentRegex must match payload
      if (p.pathRegex) {
        if (!fileTargetPath) continue;
        if (!p.pathRegex.test(fileTargetPath)) continue;
        if (p.contentRegex && !p.contentRegex.test(payload)) continue;
        return cls;
      }
    }
  }
  return null;
}
