'use client';

/**
 * WorkspaceSwitchRedirect — /lab companion (2026-05-01).
 *
 * Listens for the global `workspace-change` CustomEvent (dispatched by
 * `useSetWorkspace`) and navigates, within the /lab context, to the
 * dedicated workspace page (`/workspaces/<id>`). Background:
 *
 * - `useSetWorkspace` only persists to localStorage + dispatches an
 *   event. On normal workspace routes the page component reacts to the
 *   event and re-renders; in the /lab context, however, there is no
 *   workspace-specific page, so the user stays stuck on /lab.
 *
 * - Solution: include this component in /lab layouts. It performs the
 *   `router.push` as a side-effect reaction to the event.
 *
 * Special cases:
 * - `__root__` and `__org_root__:<id>` are virtual roots — no
 *   redirect, the user should stay in the /lab context.
 * - No loop risk: `router.push` to the other route triggers no
 *   further `workspace-change` (the event only arises from
 *   `useSetWorkspace` calls, not from navigation).
 */

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { WORKSPACE_CHANGE_EVENT, type WorkspaceChangeDetail } from '@/lib/nav/types';

export function WorkspaceSwitchRedirect(): React.JSX.Element | null {
  const router = useRouter();

  useEffect(() => {
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<WorkspaceChangeDetail>).detail;
      const wsId = detail?.workspace?.id;
      if (!wsId) return;
      // Virtual root workspaces: stay in /lab.
      if (wsId === '__root__') return;
      if (wsId.startsWith('__org_root__:')) return;
      router.push(`/workspaces/${encodeURIComponent(wsId)}`);
    };
    window.addEventListener(WORKSPACE_CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGE_EVENT, handler);
    };
  }, [router]);

  return null;
}
