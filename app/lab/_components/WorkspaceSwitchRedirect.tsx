'use client';

/**
 * WorkspaceSwitchRedirect — /lab Companion (2026-05-01).
 *
 * Lauscht auf das globale `workspace-change`-CustomEvent (von
 * `useSetWorkspace` dispatched) und navigiert in /lab-Kontext zur
 * dedizierten Workspace-Page (`/workspaces/<id>`). Hintergrund:
 *
 * - `useSetWorkspace` persistiert nur in localStorage + dispatcht ein
 *   Event. Auf normalen Workspace-Routen reagiert die Page-Komponente
 *   auf das Event und re-rendert; im /lab-Kontext gibt es jedoch keine
 *   Workspace-spezifische Page, also bleibt der User auf /lab hängen.
 *
 * - Lösung: in /lab-Layouts dieses Komponente einbinden. Sie macht den
 *   `router.push` als seiteneffekt-Reaktion auf das Event.
 *
 * Spezialfälle:
 * - `__root__` und `__org_root__:<id>` sind virtuelle Roots — kein
 *   Redirect, der User soll im /lab-Kontext bleiben.
 * - Kein Loop-Risiko: `router.push` zur fremden Route triggert kein
 *   weiteres `workspace-change` (Event entsteht nur durch
 *   `useSetWorkspace`-Aufrufe, nicht durch Navigation).
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
      // Virtuelle Root-Workspaces: in /lab bleiben.
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
