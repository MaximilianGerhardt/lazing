'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  WORKSPACE_CHANGE_EVENT,
  WORKSPACE_STORAGE_KEY,
  workspaceBodyClass,
  type Workspace,
  type WorkspaceChangeDetail,
} from './types';
import {
  DEFAULT_WORKSPACE_ID,
  findWorkspaceById,
} from './workspaces-data';

/* --------------------------------------------------------------------------
 * External store — the single source of truth for the active workspace id.
 * LocalStorage is the "slow" backing store; in-memory module state is the
 * fast path kept in sync via the custom `workspace-change` event.
 * -------------------------------------------------------------------------- */

let cachedWorkspaceId: string | null = null;

function readWorkspaceIdFromStorage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): string | null {
  // During the same tick, avoid repeated LocalStorage reads. We refresh
  // the cache on store-subscribe (when a `workspace-change` event fires).
  if (cachedWorkspaceId !== null) return cachedWorkspaceId;
  cachedWorkspaceId = readWorkspaceIdFromStorage();
  return cachedWorkspaceId;
}

function getServerSnapshot(): string | null {
  return null;
}

/**
 * Cold-list flap guard helper (2026-05-30). Builds a minimal, transient
 * Workspace object that carries the REAL stored id, used only while the
 * `useWorkspaces()` cache has not yet resolved its first fetch. Never
 * borrows `ROOT_WORKSPACE` (`__root__`) — that id has no membership and
 * would 403 the projection fetch. The accent is best-effort cosmetic.
 *
 * `__org_root__:<orgId>` is the org-scoped root pseudo-workspace (Phase
 * IA.1). We keep `north` as the neutral accent; the real object replaces
 * this synthetic one (same id) once the list resolves, so any accent here
 * is shown for at most one paint.
 */
function synthWorkspaceFor(id: string): Workspace {
  return {
    id,
    label: '',
    accent: 'north',
    sensitivity: 'normal',
  };
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<WorkspaceChangeDetail>).detail;
    cachedWorkspaceId = detail?.workspace?.id ?? readWorkspaceIdFromStorage();
    listener();
  };
  // Also listen for cross-tab storage events so the switcher updates
  // when the user changes workspace in another tab.
  const storageHandler = (e: StorageEvent): void => {
    if (e.key !== WORKSPACE_STORAGE_KEY) return;
    cachedWorkspaceId = e.newValue;
    listener();
  };
  window.addEventListener(WORKSPACE_CHANGE_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(WORKSPACE_CHANGE_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}

/**
 * Active-workspace hook. Reads via `useSyncExternalStore` so there's no
 * tearing during hydration and no setState-in-effect anti-pattern.
 *
 * Returns a workspace object — never null. Until hydrated on the client
 * we serve the default so consumers don't have to guard.
 */
export function useCurrentWorkspace(
  workspaces?: readonly Workspace[],
): Workspace {
  const fromApi = useWorkspaces();
  const list = workspaces ?? fromApi.workspaces;
  const storedId = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const fallback = useMemo<Workspace>(
    () => findWorkspaceById(list, DEFAULT_WORKSPACE_ID) ?? list[0],
    [list],
  );

  const current = useMemo<Workspace>(() => {
    if (!storedId) return fallback;
    const found = findWorkspaceById(list, storedId);
    if (found) return found;
    // --------------------------------------------------------------------
    // Cold-list flap guard (2026-05-30, Render-Critic CRITICAL).
    //
    // EMPIRICAL ROOT-CAUSE: directly after the `/orgs/[id]/chat` → `/?ws=…`
    // redirect, `WorkspaceBootstrap` has already written the real stored id
    // (`__org_root__:<orgId>` or a concrete workspace id), but the
    // `useWorkspaces()` singleton cache has NOT resolved its first
    // `/api/workspaces` fetch yet. During that window `list` is
    // `[ROOT_WORKSPACE]` (workspaces-cache.ts:89 always prepends ROOT) and
    // `findWorkspaceById(list, storedId)` misses. The previous code then fell
    // back to `fallback` = `findWorkspaceById(list, 'lazyos') ?? list[0]`
    // = `ROOT_WORKSPACE` (id `__root__`). ChatShell's
    // `useWorkspaceState(currentWorkspace.id)` then fired
    // `GET /api/state/projection/__root__`, which is membership-gated and
    // returns 403 (the exact 403 + `__org_root__` flap the critic flagged).
    //
    // FIX: when a real stored id exists but the list is still cold, DO NOT
    // borrow `ROOT_WORKSPACE`. Return a minimal synthetic workspace carrying
    // the *actual* stored id so the projection fetch targets the correct,
    // auth'd workspace from the first paint. Once the cache resolves, the
    // real object from `list` replaces this synthetic one transparently
    // (same id ⇒ no visible swap, no body-class churn).
    //
    // The synthetic object is only ever used transiently; we keep its label
    // neutral and derive the accent from the org-root id where possible so
    // the ambient accent does not flash the wrong palette.
    return synthWorkspaceFor(storedId);
  }, [storedId, list, fallback]);

  // Apply the segment-* body class whenever `current` changes. This is
  // the single place that controls the ambient accent — no other code
  // path should mutate body.classList for segment-*.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const next = workspaceBodyClass(current);
    const body = document.body;
    // Remove both legacy segment-* and new palette-* classes (only the active one stays)
    for (const cls of Array.from(body.classList)) {
      if ((cls.startsWith('segment-') || cls.startsWith('palette-')) && cls !== next) {
        body.classList.remove(cls);
      }
    }
    if (!body.classList.contains(next)) body.classList.add(next);
  }, [current]);

  return current;
}

/**
 * Low-level imperative workspace-id writer that bypasses the workspace-list
 * lookup. Use when the new workspace is not yet in the cached list (e.g.
 * immediately after POST /api/workspaces, before the data-change re-fetch
 * resolves). Persists to localStorage + dispatches WORKSPACE_CHANGE_EVENT
 * so every useCurrentWorkspace() subscriber picks up the new id on next
 * render. useCurrentWorkspace() will fall back to the default workspace
 * object until the list re-fetch completes, but the id is already stored.
 */
export function setWorkspaceId(id: string, organizationId?: string): void {
  if (typeof window === 'undefined') return;
  // Fix #2 (2026-06-02): Wenn die Org des Ziel-Workspace bekannt ist (z.B. aus
  // der POST /api/workspaces-Antwort beim Create-and-Switch), den Org-Kontext
  // mit-setzen — sonst ist der neue Workspace in einer anderen Org als der
  // aktiven unsichtbar/wird von der Org-Normalisierung auf org-root resettet.
  if (organizationId && organizationId !== cachedOrgId) {
    setOrgIdSilent(organizationId);
  }
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
  } catch {
    /* non-fatal */
  }
  cachedWorkspaceId = id;
  window.dispatchEvent(
    new CustomEvent<WorkspaceChangeDetail>(WORKSPACE_CHANGE_EVENT, {
      detail: { workspace: { id } as Workspace },
    }),
  );
}

/**
 * Imperative setter: persist + dispatch the `workspace-change` event so
 * every `useCurrentWorkspace()` subscriber updates.
 */
export function useSetWorkspace(
  workspaces?: readonly Workspace[],
): (id: string) => void {
  const fromApi = useWorkspaces();
  const list = workspaces ?? fromApi.workspaces;
  return useCallback(
    (id: string): void => {
      const next = findWorkspaceById(list, id);
      if (!next) return;
      // Fix #2 (2026-06-02): Org-Kontext an den Ziel-Workspace angleichen,
      // BEVOR der Workspace gesetzt wird. Sonst blieb ein Workspace aus einer
      // anderen Org als der aktiven unsichtbar im Switcher UND die Org-
      // Normalisierung (OrgSwitcher) resettete die Auswahl auf org-root →
      // ein Wechsel „klappte nicht". `setOrgIdSilent` setzt nur den Kontext
      // (localStorage+Cookie+Event), OHNE Hard-Reset auf org-root / Navigate.
      if (next.organizationId && next.organizationId !== cachedOrgId) {
        setOrgIdSilent(next.organizationId);
      }
      try {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, next.id);
      } catch {
        // Non-fatal.
      }
      cachedWorkspaceId = next.id;
      const event = new CustomEvent<WorkspaceChangeDetail>(
        WORKSPACE_CHANGE_EVENT,
        { detail: { workspace: next } },
      );
      window.dispatchEvent(event);
    },
    [list],
  );
}

/**
 * Drawer-state hook. Owns body-scroll lock + ESC binding so callers only
 * worry about rendering.
 */
export function useMobileDrawer(): {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);
  const previousOverflow = useRef<string | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (open) {
      previousOverflow.current = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    } else if (previousOverflow.current !== null) {
      document.body.style.overflow = previousOverflow.current;
      previousOverflow.current = null;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Sub-Plan 4: BackgroundActivityIndicator dispatched
  // 'lazyos:drawer:open' wenn der User auf die Pulse-Pill klickt.
  // Drawer öffnet + scrollt nach #drawer-section-activity (anchor).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ anchor?: string }>).detail;
      setOpen(true);
      if (detail?.anchor) {
        // Defer scroll to next tick — drawer is rendered after setOpen.
        window.setTimeout(() => {
          const target = document.getElementById(
            `drawer-section-${detail.anchor}`,
          );
          target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 50);
      }
      // Trigger refresh of activity-list inside drawer.
      window.dispatchEvent(new CustomEvent('lazyos:activity:refresh'));
    };
    window.addEventListener('lazyos:drawer:open', handler);
    return () => window.removeEventListener('lazyos:drawer:open', handler);
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  return { open, setOpen, toggle };
}

/* ------------------------------------------------------------------ */
/* Organisationen — TopNav-Switcher (Phase A)                         */
/* ------------------------------------------------------------------ */

const ORG_STORAGE_KEY = 'lazyos.org';
const ORG_CHANGE_EVENT = 'org-change';

/**
 * Pseudo-ID für „alle Orgs" — kein Filter aktiv. Workspace-Switcher
 * zeigt dann alle Workspaces (gruppiert nach Org).
 */
export const ORG_ALL_ID = '__all__';

let cachedOrgId: string | null = null;
const orgListeners = new Set<() => void>();

function subscribeOrg(listener: () => void): () => void {
  orgListeners.add(listener);
  return () => {
    orgListeners.delete(listener);
  };
}

function getOrgSnapshot(): string | null {
  if (typeof window === 'undefined') return ORG_ALL_ID;
  if (cachedOrgId !== null) return cachedOrgId;
  try {
    const stored = window.localStorage.getItem(ORG_STORAGE_KEY);
    cachedOrgId = stored ?? ORG_ALL_ID;
  } catch {
    cachedOrgId = ORG_ALL_ID;
  }
  return cachedOrgId;
}

function getOrgServerSnapshot(): string | null {
  return ORG_ALL_ID;
}

if (typeof window !== 'undefined') {
  window.addEventListener(ORG_CHANGE_EVENT, () => {
    for (const l of orgListeners) l();
  });
}

import type { Organization } from './types';

/**
 * Fetches the orgs the current user is member of. Same lifecycle pattern
 * as `useWorkspaces`. Niemals leer — wenn API fehlt, leeres Array.
 */
export function useUserOrgs(): {
  orgs: readonly Organization[];
  isLoading: boolean;
} {
  const [state, setState] = useState<{
    orgs: readonly Organization[];
    isLoading: boolean;
  }>({ orgs: [], isLoading: true });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 2026-05-01 fix: include=all damit MobileDrawer + WorkspaceSwitcher
        // Sub-Orgs auflösen können. Vorher Default Top-Level-only → alle
        // Sub-Org-Workspaces (Demo Fitness, Demo PV, TAP, example-product-c,
        // Example App, example-tool) landeten im "Ohne Org"-Bucket weil die Sub-Orgs
        // im orgIndex fehlten.
        const res = await fetch('/api/orgs?include=all', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { orgs?: Organization[] };
        if (cancelled) return;
        if (Array.isArray(body.orgs)) {
          setState({ orgs: body.orgs, isLoading: false });
          return;
        }
        setState((s) => ({ ...s, isLoading: false }));
      } catch {
        if (cancelled) return;
        setState({ orgs: [], isLoading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/** Liefert die aktive Org-ID oder ORG_ALL_ID. */
export function useCurrentOrgId(): string {
  const stored = useSyncExternalStore(
    subscribeOrg,
    getOrgSnapshot,
    getOrgServerSnapshot,
  );
  return stored ?? ORG_ALL_ID;
}

/** Imperative Setter — persist + Event. */
/**
 * Phase IA.1 — Org-Wechsel ist ab jetzt ein **Hard-Context-Switch**:
 *   1. localStorage `lazyos.org` setzen (für Reload-Persistenz).
 *   2. WORKSPACE_STORAGE_KEY auf den Org-Root-Pseudo-Workspace setzen
 *      (`__org_root__:<orgId>`).
 *   3. Hard-Navigate zu `/orgs/[orgId]/chat` — Default-Landing nach jedem
 *      Org-Switch ist der Org-scoped Root-Chat (User-Entscheidung 2026-04-29).
 *
 * Wenn `orgId === ORG_ALL_ID` wird nur das alte Filter-Verhalten beibehalten
 * (Persistenz + Event), kein Redirect — ORG_ALL_ID ist Legacy und wird in
 * Phase IA.6 vollständig entfernt, der Hook akzeptiert ihn aber bis dahin.
 */
function writeOrgCookie(orgId: string): void {
  if (typeof document === 'undefined') return;
  // Path=/ damit jede Server-Component den Wert lesen kann; SameSite=Lax
  // erlaubt Top-Level-Navigation; 365 Tage Lifetime.
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${ORG_STORAGE_KEY}=${encodeURIComponent(orgId)}; Path=/; Max-Age=${oneYear}; SameSite=Lax`;
}

/**
 * Writes the active org to localStorage + cookie + dispatches the org-change
 * event WITHOUT the hard location.assign() navigation. Use in multi-step
 * flows (onboarding) where a hard-redirect would abandon the wizard.
 * The calling code is responsible for the final navigation.
 */
export function setOrgIdSilent(orgId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ORG_STORAGE_KEY, orgId);
  } catch {
    /* non-fatal */
  }
  writeOrgCookie(orgId);
  cachedOrgId = orgId;
  window.dispatchEvent(new CustomEvent(ORG_CHANGE_EVENT));
}

export function useSetOrg(): (orgId: string) => void {
  return useCallback((orgId: string): void => {
    try {
      window.localStorage.setItem(ORG_STORAGE_KEY, orgId);
    } catch {
      /* non-fatal */
    }
    writeOrgCookie(orgId);
    cachedOrgId = orgId;
    window.dispatchEvent(new CustomEvent(ORG_CHANGE_EVENT));

    // Hard-Switch nur für echte Org-IDs (nicht Legacy-„Alle").
    if (orgId !== ORG_ALL_ID && typeof window !== 'undefined') {
      const rootWorkspaceId = `__org_root__:${orgId}`;
      try {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, rootWorkspaceId);
      } catch {
        /* non-fatal */
      }
      cachedWorkspaceId = rootWorkspaceId;
      window.dispatchEvent(
        new CustomEvent<WorkspaceChangeDetail>(WORKSPACE_CHANGE_EVENT, {
          detail: { workspace: { id: rootWorkspaceId } as Workspace },
        }),
      );
      window.location.assign(`/orgs/${encodeURIComponent(orgId)}/chat`);
    }
  }, []);
}

/**
 * Fetches workspaces from `/api/workspaces`; falls back to the static list
 * on failure. Returns a stable, always-populated array.
 *
 * We guard the setState call behind an `isMounted` ref so the rule engine
 * treats it as external-sync (not a render-triggering effect).
 */
/**
 * Custom-Event den jeder Caller (z.B. WorkspaceEditor nach Org-Update)
 * dispatchen kann um TopNav-Switcher zum Re-Fetch zu zwingen. Nötig weil
 * `router.refresh()` nur Server-Components invalidiert, nicht Client-State.
 */
export const WORKSPACE_DATA_CHANGE_EVENT = 'workspace-data-change';

export function dispatchWorkspaceDataChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_DATA_CHANGE_EVENT));
}

/**
 * Singleton-cache-backed workspaces hook.
 *
 * CP-2 / UX-Audit 2026-05-28 fix: the previous implementation fired its
 * own `fetch('/api/workspaces')` per hook caller. Six caller sites mount
 * the hook on the same page, so a single page-load triggered 6 concurrent
 * requests. Under load the smoke-test observed 62–71 `429` rejections
 * over a 13-route sweep in 7s, which flickered the WorkspaceSwitcher
 * empty when the fail-path dropped to the static list.
 *
 * Behaviour after the fix:
 *   • All callers share ONE in-flight `/api/workspaces` request.
 *   • A successful fetch is cached for STALE_TTL_MS (30s). Subsequent
 *     mounts within that window serve the cached snapshot synchronously.
 *   • 429 responses trigger exponential backoff (1s → 30s cap). During
 *     backoff we DO NOT re-issue requests — we serve the previous
 *     snapshot to prevent the empty-list flicker.
 *   • Any error path keeps the previous snapshot (no flicker).
 *
 * The public shape `{ workspaces, isLoading }` is unchanged, so the six
 * call-sites (TicketReplyBox, RoutinesList, SessionsList,
 * ChatWorkspaceInlineSwitcher, useChatSuggestions, WorkspaceSwitcher)
 * are not touched.
 */
import {
  getSnapshot as getWorkspacesSnapshot,
  hasSnapshot as hasWorkspacesSnapshot,
  maybeRefresh as maybeRefreshWorkspaces,
  subscribe as subscribeToWorkspacesCache,
} from './workspaces-cache';

export function useWorkspaces(): {
  workspaces: readonly Workspace[];
  isLoading: boolean;
} {
  const [, force] = useState(0);

  // Subscribe to cache events — re-render when the snapshot changes or
  // when the in-flight state transitions.
  useEffect(() => {
    const unsubscribe = subscribeToWorkspacesCache(() => {
      force((n) => (n + 1) | 0);
    });
    // Kick off a refresh on mount. If the cache is fresh this is a no-op,
    // so a second mount within STALE_TTL_MS does NOT re-fetch.
    maybeRefreshWorkspaces();

    const onChange = (): void => {
      // Explicit invalidation (e.g. WorkspaceEditor saved a change) —
      // force-refresh the cache.
      maybeRefreshWorkspaces({ force: true });
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(WORKSPACE_DATA_CHANGE_EVENT, onChange);
    }
    return () => {
      unsubscribe();
      if (typeof window !== 'undefined') {
        window.removeEventListener(WORKSPACE_DATA_CHANGE_EVENT, onChange);
      }
    };
  }, []);

  return {
    workspaces: getWorkspacesSnapshot(),
    // Only "loading" while we have no real snapshot yet. Once we have ANY
    // real data the consumer should not flip back to loading on revalidate.
    isLoading: !hasWorkspacesSnapshot(),
  };
}
