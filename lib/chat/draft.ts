'use client';

/**
 * lib/chat/draft.ts
 * -----------------
 * Phase Reload-Recovery V2 · 2026-04-27.
 *
 * Persists the not-yet-sent composer text per workspace, so a `Cmd+R`
 * mid-typing does not cause a loss. Source of truth is `localStorage`,
 * key schema:
 *
 *   `lazyos.chat.draft.{workspaceId}`
 *
 * Lifecycle:
 *   - Mount → restore: read key, fill the composer (parent hook does that).
 *   - Typing → debounced 500ms persist.
 *   - Successfully sent (`chat_message_sent`) → clear.
 *   - Workspace switch → writes under the old key, reads the new key.
 *
 * Robustness:
 *   - Storage errors (private mode, quota) are swallowed — never throw.
 *   - SSR-safe: lazy access to window.
 *   - Strings > 64KB are truncated (no memory bloat for giant pastes).
 */

import { useEffect, useRef } from 'react';

const STORAGE_DRAFT_BASE = 'lazyos.chat.draft';
const MAX_DRAFT_LEN = 64 * 1024;
const DEBOUNCE_MS = 500;

function draftKeyFor(workspaceId: string): string {
  return `${STORAGE_DRAFT_BASE}.${workspaceId}`;
}

/**
 * Read the stored draft for a workspace. Returns null if
 * empty or unparseable.
 */
export function readDraftFor(workspaceId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(draftKeyFor(workspaceId));
    if (raw === null) return null;
    if (typeof raw !== 'string') return null;
    if (raw.length === 0) return null;
    return raw.length > MAX_DRAFT_LEN ? raw.slice(0, MAX_DRAFT_LEN) : raw;
  } catch {
    return null;
  }
}

/**
 * Write the draft (no debounce — the caller debounces via the hook).
 */
export function writeDraftFor(workspaceId: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (value.length === 0) {
      window.localStorage.removeItem(draftKeyFor(workspaceId));
      return;
    }
    const v = value.length > MAX_DRAFT_LEN ? value.slice(0, MAX_DRAFT_LEN) : value;
    window.localStorage.setItem(draftKeyFor(workspaceId), v);
  } catch {
    /* quota / private-mode — ignore */
  }
}

/**
 * Delete the draft (the caller invokes this on `chat_message_sent`).
 */
export function clearDraftFor(workspaceId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(draftKeyFor(workspaceId));
  } catch {
    /* ignore */
  }
}

/**
 * Hook: persists `value` debounced (500ms) into localStorage.
 *
 * - On mount/workspace switch: read the stored draft via `readDraftFor`
 *   and call `onRestore(value)` (exactly once per workspace).
 * - On every `value` change: debounced write.
 * - On workspace switch: the old draft is kept under the old ID,
 *   the new draft is restored under the new ID.
 *
 * The caller takes care that:
 *   - `value` is controlled (comes from the composer parent's state).
 *   - `onRestore` sets the composer state, should be stabilized with
 *     `useCallback` (otherwise restore runs on every render — see
 *     `restoredForRef` which prevents that).
 *
 * Returns nothing — side-effect hook.
 */
export function useDraftPersistence(
  workspaceId: string,
  value: string,
  onRestore: (restored: string) => void,
): void {
  // So the restore effect fires only once per workspace, even when
  // `onRestore` is unstable.
  const restoredForRef = useRef<string | null>(null);
  // So the persist effect does not misinterpret the workspace switch as a
  // "new value" and immediately write an empty draft over the restored one.
  const lastWorkspaceRef = useRef<string | null>(null);
  // One debounce timer per hook instance.
  const debounceRef = useRef<number | null>(null);
  // onRestore callback in a ref so the restore effect does not re-run
  // when the caller recreates the function on every render.
  const onRestoreRef = useRef(onRestore);
  useEffect(() => {
    onRestoreRef.current = onRestore;
  }, [onRestore]);

  // Sentinel: the caller signals "no draft persist wanted" via a
  // double-underscore prefix (e.g. `__no_persist__`). Hook becomes a no-op.
  const persistDisabled = workspaceId.startsWith('__');

  // ---- Restore on mount + workspace-switch ----
  useEffect(() => {
    if (persistDisabled) return;
    if (restoredForRef.current === workspaceId) return;
    restoredForRef.current = workspaceId;
    lastWorkspaceRef.current = workspaceId;
    const stored = readDraftFor(workspaceId);
    if (stored !== null && stored.length > 0) {
      onRestoreRef.current(stored);
    }
  }, [workspaceId, persistDisabled]);

  // ---- Persist on value change (debounced) ----
  useEffect(() => {
    if (persistDisabled) return;
    // Workspace switch: do NOT persist, only update the ref.
    // The restore effect handles filling with the stored value.
    if (lastWorkspaceRef.current !== workspaceId) {
      lastWorkspaceRef.current = workspaceId;
      return;
    }
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    debounceRef.current = window.setTimeout(() => {
      writeDraftFor(workspaceId, value);
      debounceRef.current = null;
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [workspaceId, value, persistDisabled]);
}
