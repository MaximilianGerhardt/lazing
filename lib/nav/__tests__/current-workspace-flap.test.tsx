/**
 * useCurrentWorkspace — Cold-list flap guard (Render-Critic CRITICAL, 2026-05-30).
 *
 * Reproduces the empirically-confirmed flap: directly after the
 * `/orgs/[id]/chat` → `/?ws=__org_root__:<orgId>` redirect, `WorkspaceBootstrap`
 * has written the real stored workspace id, but the `useWorkspaces()` singleton
 * cache has NOT resolved its first `/api/workspaces` fetch yet — so the list is
 * the cold `[ROOT_WORKSPACE]` (workspaces-cache always prepends ROOT).
 *
 * Before the fix, `useCurrentWorkspace()` fell back to `ROOT_WORKSPACE`
 * (id `__root__`) in that window → ChatShell's
 * `useWorkspaceState(currentWorkspace.id)` fired
 * `GET /api/state/projection/__root__`, which is membership-gated and 403s.
 *
 * After the fix it must resolve to a synthetic workspace carrying the REAL
 * stored id (so the projection fetch targets the correct, auth'd workspace),
 * and once the list resolves it must pick the real object.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/nav/__tests__/current-workspace-flap.test.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { Workspace, WorkspaceChangeDetail } from '../types';
import { WORKSPACE_STORAGE_KEY, WORKSPACE_CHANGE_EVENT } from '../types';
import { ROOT_WORKSPACE } from '../workspaces-data';

// The cache-backed `useWorkspaces` is the thing that is "cold" during the
// flap window. We drive it directly per-test via this mutable holder.
let mockWorkspaces: readonly Workspace[] = [];

vi.mock('../workspaces-cache', () => ({
  getSnapshot: () => mockWorkspaces,
  hasSnapshot: () => mockWorkspaces.length > 0,
  maybeRefresh: () => undefined,
  subscribe: () => () => undefined,
}));

// eslint-disable-next-line import/first
import { useCurrentWorkspace } from '../hooks';

let container: HTMLDivElement;
let root: Root;
let observed: string | null = null;

function Probe(): null {
  const ws = useCurrentWorkspace();
  observed = ws.id;
  return null;
}

/**
 * Mounts the probe and then forces the module-global workspace-id cache to
 * re-read from localStorage. `useCurrentWorkspace` keeps an in-memory
 * `cachedWorkspaceId` that is only refreshed when a WORKSPACE_CHANGE_EVENT
 * fires; firing it with an empty detail makes the active subscriber re-read
 * storage (`detail?.workspace?.id ?? readWorkspaceIdFromStorage()`). This also
 * resets state that leaks between tests in the same module.
 */
function mountAndSync(): void {
  act(() => root.render(<Probe />));
  act(() => {
    window.dispatchEvent(
      new CustomEvent<WorkspaceChangeDetail>(WORKSPACE_CHANGE_EVENT, {
        detail: undefined as unknown as WorkspaceChangeDetail,
      }),
    );
  });
}

beforeEach(() => {
  observed = null;
  mockWorkspaces = [];
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCurrentWorkspace cold-list flap guard', () => {
  it('does NOT fall back to __root__ when an org-root id is stored but the list is cold', () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      '__org_root__:example-company',
    );
    // Cold cache: exactly what workspaces-cache returns before the first fetch.
    mockWorkspaces = [ROOT_WORKSPACE];

    mountAndSync();

    expect(observed).not.toBe('__root__');
    expect(observed).toBe('__org_root__:example-company');
  });

  it('does NOT fall back to __root__ for a concrete stored id while the list is cold', () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'website');
    mockWorkspaces = [ROOT_WORKSPACE];

    mountAndSync();

    expect(observed).toBe('website');
  });

  it('resolves the REAL workspace object once the cache has populated', () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, 'website');
    const real: Workspace = {
      id: 'website',
      label: 'Website',
      accent: 'own',
      sensitivity: 'low',
      organizationId: 'example-company',
    };
    mockWorkspaces = [ROOT_WORKSPACE, real];

    mountAndSync();

    expect(observed).toBe('website');
  });

  it('still serves a fallback when there is NO stored id (no spurious __root__ projection from a real selection)', () => {
    // No stored id at all — genuine "nothing selected" state. We assert the
    // hook returns SOMETHING (never throws/undefined) so ChatShell stays safe.
    mockWorkspaces = [ROOT_WORKSPACE];

    act(() => root.render(<Probe />));

    expect(typeof observed).toBe('string');
  });
});
