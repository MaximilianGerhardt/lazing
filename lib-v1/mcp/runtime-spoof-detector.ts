// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-RAG-06 — K1-Defense Schicht-2 helper: B-R6 catch-all spoof detector
// Authority: modules/W2/M-RAG-06/TOOL-REGISTRY-FILTER-SPEC.md (BUG-FIX-1)
//
// Three-stage detection that catches substring-bleed / nested-`__` / case /
// homoglyph spoofs against the canonical `mcp__local-rag__*` /
// `mcp__standards-rag__*` prefixes.
//
// Original (broken) regex `/^mcp__[^_]*[_-]?rag[_-]?[^_]*__.*$/` failed B-R6:
//   /^mcp__[^_]*[_-]?rag[_-]?[^_]*__.*$/.test('mcp__local__rag__do_thing')
//   === false      (the [^_]* class cannot cross the `__` separator)
//
// BUG-FIX-1 replaces it with a broad-net regex + string-validator + word-boundary
// check. Each layer has been empirically verified in Node REPL — see test file
// for the verified vector matrix.

import { detectMixedScript } from '../security/homoglyph-detect';

/**
 * STAGE 1 — Broad-net regex (deny-by-default).
 *
 * Matches ANY permutation of "rag" in the server-segment, including nested-`__`
 * spoofs (`mcp__local__rag__do`), suffix-bleed (`mcp__local-rag-helper__`),
 * multi-nested (`mcp__foo__bar__rag__qux`), no-separator (`mcp__localrag__`),
 * case-variants (`MCP__RAG__leak` via /i flag).
 *
 * Empirically verified — see __tests__/runtime-spoof-detector.test.ts.
 */
export const SPOOF_BROAD_REGEX = /^mcp__[a-zA-Z0-9_-]*rag[a-zA-Z0-9_-]*__.*$/i;

/**
 * STAGE 2 — String-validator (belt-and-suspenders).
 *
 * Deterministic check independent of regex-engine quirks. Catches anything
 * that starts with the canonical MCP prefix AND contains "rag" (case-insensitive).
 */
export function isMcpRagSubstring(name: string): boolean {
  if (typeof name !== 'string') return false;
  // BUG-FIX-2 K1-PEN R3-followup: case-insensitive prefix check so that
  // MCP__FILESYSTEM__RAG_QUERY (all-caps) does not slip past stage-2.
  const lower = name.toLowerCase();
  if (!lower.startsWith('mcp__')) return false;
  return lower.includes('rag');
}

/**
 * STAGE 3 — Word-boundary check (strong-deny escalation).
 *
 * Splits the name into `__`-separated segments and checks all segments EXCEPT
 * the last (tool-name) for a word-bounded "rag" — i.e. preceded by ^ / `_` / `-`
 * and followed by $ / `_` / `-`. This distinguishes:
 *   - true rag-word spoofs (`local-rag`, `rag-shim`)  → match → strong-deny
 *   - FP candidates (`drag`, `brokerage`, `storage`)   → no match → broad-deny
 */
export function hasWordBoundaryRag(name: string): boolean {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  if (!lower.startsWith('mcp__')) return false;
  const rest = lower.slice(5); // strip 'mcp__'
  const segments = rest.split('__');
  if (segments.length < 2) return false;
  const wordRagRe = /(?:^|[_-])rag(?:$|[_-])/;
  for (let i = 0; i < segments.length - 1; i++) {
    if (wordRagRe.test(segments[i]!)) return true;
  }
  return false;
}

/**
 * Explicit whitelist for legit "rag"-named tools. V1 is empty by design —
 * appeal-path goes through `lazyctl perm whitelist-rag-tool --name=… --reason=…`
 * which writes a `lazyos_lint_override_audit`-row (Wave-2+ work).
 */
export const WHITELIST_RAG_TOOLS: ReadonlyArray<{
  readonly name: string;
  readonly reason: string;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly auditRowId: string;
}> = Object.freeze([]);

export interface SpoofCheckResult {
  isSpoof: boolean;
  decision: 'allowed' | 'denied-strong' | 'denied-broad' | 'denied-belt' | 'denied-homoglyph';
  matchedLayer:
    | 'glob'
    | 'broad-regex'
    | 'string-validator'
    | 'word-boundary'
    | 'homoglyph'
    | 'none';
  matchedPattern: string;
  whitelistEligible: boolean;
  inWhitelist: boolean;
}

/**
 * Check whether `toolName` is a spoof-attempt against the canonical
 * `mcp__local-rag__*` / `mcp__standards-rag__*` prefixes.
 *
 * Decision tree:
 *   - whitelist match                    → allowed
 *   - homoglyph (mixed-script)           → denied-homoglyph
 *   - broad + substring + word-boundary  → denied-strong (no appeal)
 *   - broad + substring                  → denied-broad  (whitelist-eligible)
 *   - substring only (regex-bypass)      → denied-belt   (whitelist-eligible)
 *   - none                               → allowed
 */
export function checkSpoofAttempt(toolName: string): SpoofCheckResult {
  // Whitelist short-circuit
  const wl = WHITELIST_RAG_TOOLS.find((w) => w.name === toolName);
  if (wl) {
    return {
      isSpoof: false,
      decision: 'allowed',
      matchedLayer: 'none',
      matchedPattern: '',
      whitelistEligible: false,
      inWhitelist: true,
    };
  }

  // Homoglyph short-circuit — catches cyrillic/greek/etc spoofs of canonical
  // names like `mcp__filesystem__rаg_query` (cyrillic-а). Display-layer-detector
  // promoted into runtime path per K1-PEN report R3 mitigation.
  const homoglyph = detectMixedScript(toolName);
  if (homoglyph.isMixed) {
    return {
      isSpoof: true,
      decision: 'denied-homoglyph',
      matchedLayer: 'homoglyph',
      matchedPattern: `mixed-script:${homoglyph.scripts.join(',')}`,
      whitelistEligible: false,
      inWhitelist: false,
    };
  }

  const broad = SPOOF_BROAD_REGEX.test(toolName);
  const substring = isMcpRagSubstring(toolName);
  const wordBoundary = hasWordBoundaryRag(toolName);

  if (broad && substring && wordBoundary) {
    return {
      isSpoof: true,
      decision: 'denied-strong',
      matchedLayer: 'word-boundary',
      matchedPattern: 'word-boundary-rag(segment-level)',
      whitelistEligible: false,
      inWhitelist: false,
    };
  }
  if (broad && substring) {
    return {
      isSpoof: true,
      decision: 'denied-broad',
      matchedLayer: 'broad-regex',
      matchedPattern: SPOOF_BROAD_REGEX.source,
      whitelistEligible: true,
      inWhitelist: false,
    };
  }
  if (substring && !broad) {
    return {
      isSpoof: true,
      decision: 'denied-belt',
      matchedLayer: 'string-validator',
      matchedPattern: 'startsWith(mcp__) && includes(rag)',
      whitelistEligible: true,
      inWhitelist: false,
    };
  }
  return {
    isSpoof: false,
    decision: 'allowed',
    matchedLayer: 'none',
    matchedPattern: '',
    whitelistEligible: false,
    inWhitelist: false,
  };
}

/**
 * Pre-normalize a tool-name string before matching. Strips:
 *   - leading/trailing whitespace
 *   - zero-width characters (ZWJ U+200D, ZWNJ U+200C, ZWSP U+200B, BIDI U+202?-206F)
 *   - applies NFKC normalization (compatibility decomposition)
 *   - case-folds for the lower-case compare path (callers can pick raw or normalized)
 *
 * Returns both the normalized name AND a flag indicating whether normalization
 * changed anything — callers can treat "name changed during normalization" as
 * itself suspicious (spoof-attempt).
 */
export function normalizeToolName(name: string): {
  normalized: string;
  changed: boolean;
} {
  if (typeof name !== 'string') return { normalized: '', changed: true };
  let n = name;
  // Strip BIDI / zero-width / invisible separators / RLO / LRO / etc.
  n = n.replace(
    /[​-‏‪-‮⁠-⁯⁡⁢⁣⁤﻿]/g,
    '',
  );
  // Strip leading/trailing whitespace
  n = n.trim();
  // NFKC normalization (folds compatibility variants)
  n = n.normalize('NFKC');
  return { normalized: n, changed: n !== name };
}

export const __test_only = {
  SPOOF_BROAD_REGEX,
  WHITELIST_RAG_TOOLS,
};
