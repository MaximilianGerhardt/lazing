'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { IconChevronDown, IconCheck } from './icons';
import {
  ORG_ALL_ID,
  useCurrentOrgId,
  useCurrentWorkspace,
  useSetWorkspace,
  useUserOrgs,
  useWorkspaces,
} from './hooks';
import { NewWorkspaceForm } from './NewWorkspaceForm';
// SECTION_DEFS removed — sub-org hierarchy instead of type sections (2026-04-29).

import type { Workspace } from './types';

/**
 * Workspace-dropdown — the primary switch lives permanently in the
 * top-right of the header on ALL viewports (desktop + mobile). Acts
 * like a native select: click opens a floating popover; ↑/↓ walks
 * the options; Enter/Space selects; ESC closes; click-outside closes;
 * selection persists via `useSetWorkspace` which also flips the
 * `body.segment-*` class so the ambient accent changes live without
 * reload.
 *
 * Layout:
 *   [● Demo PV ▾]   — desktop (full label)
 *   [● EH ▾]               — narrow viewports (<380px) via CSS
 *
 * Popover is anchored right-aligned; on iPhone widths it clamps to
 * `calc(100vw - 24px)` (see components.css) and anchors the right edge
 * flush with the trigger so it never overflows the viewport.
 */
export function WorkspaceSwitcher(): React.JSX.Element {
  const { workspaces } = useWorkspaces();
  const current = useCurrentWorkspace(workspaces);
  const setWorkspace = useSetWorkspace(workspaces);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  // 2026-05-03 — inline create mode inside the popover (no modal,
  // see memory pin „ KEINE Overlays"). Toggle via the footer row.
  const [mode, setMode] = useState<'list' | 'create'>('list');

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Phase IA.1 — the workspace switcher shows only workspaces of the active org.
  // ORG_ALL_ID is legacy → fall back to the first user org.
  const currentOrgIdRaw = useCurrentOrgId();
  const { orgs: userOrgs } = useUserOrgs();
  const effectiveOrgId =
    currentOrgIdRaw !== ORG_ALL_ID
      ? currentOrgIdRaw
      : userOrgs[0]?.id ?? ORG_ALL_ID;

  // Phase IA consolidation re-fix (2026-04-29): sub-org hierarchy.
  // Visible: all workspaces whose org is directly currentOrg OR
  // whose org is a sub-org of currentOrg (parent_id === currentOrg).
  const visibleRows = useMemo<Workspace[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = (w: Workspace): boolean => {
      if (w.archived) return false;
      if (w.id === '__root__') return false;
      if (w.id.startsWith('__org_root__:')) return false;
      if (w.sensitivity === 'high' && w.id !== current.id && !q) return false;
      if (effectiveOrgId !== ORG_ALL_ID) {
        const directMatch = w.organizationId === effectiveOrgId;
        const viaSubOrg = w.organization?.parentId === effectiveOrgId;
        if (!directMatch && !viaSubOrg) return false;
      }
      if (!q) return true;
      return (
        w.label.toLowerCase().includes(q) || w.id.toLowerCase().includes(q)
      );
    };
    return workspaces.filter(matches);
  }, [workspaces, query, current.id, effectiveOrgId]);

  // Sections: one section per sub-org (sub-org name as header),
  // direct workspaces under the active org get their own
  // „Direkt" section. Order: type-prioritized (product → client → tool → private),
  // then alphabetical.
  //
  // 2026-05-03 extension: within each section we additionally group the rows
  // by `contextGroup`. We show sub-headers ONLY when ≥2
  // different group values exist in the section — otherwise visual noise.
  const sections = useMemo(() => {
    const groupsByOrg = new Map<
      string,
      { name: string; type: string; rows: Workspace[]; orgId: string }
    >();
    const directRows: Workspace[] = [];
    for (const w of visibleRows) {
      if (w.organizationId === effectiveOrgId) {
        directRows.push(w);
        continue;
      }
      const key = w.organizationId ?? '__nogrp__';
      const existing = groupsByOrg.get(key);
      if (existing) {
        existing.rows.push(w);
      } else {
        groupsByOrg.set(key, {
          orgId: key,
          name: w.organization?.name ?? key,
          type: w.organization?.type ?? 'default',
          rows: [w],
        });
      }
    }
    const TYPE_RANK: Record<string, number> = {
      company: 0,
      product: 1,
      client: 2,
      tool: 3,
      private: 4,
    };
    const sortedGroups = Array.from(groupsByOrg.values()).sort((a, b) => {
      const ra = TYPE_RANK[a.type] ?? 9;
      const rb = TYPE_RANK[b.type] ?? 9;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name, 'de');
    });

    /** Sub-group build per section: only render sub-headers when ≥2 distinct. */
    const buildSubGroups = (
      rows: readonly Workspace[],
    ): Array<{ groupLabel: string | null; rows: Workspace[] }> => {
      const buckets = new Map<string, Workspace[]>();
      for (const w of rows) {
        const key = w.contextGroup?.trim() || '__nogrp__';
        const arr = buckets.get(key);
        if (arr) arr.push(w);
        else buckets.set(key, [w]);
      }
      // If only one group (whether NULL or a single value) → no
      // sub-headers. The caller renders the rows flat.
      if (buckets.size <= 1) {
        return [{ groupLabel: null, rows: [...rows] }];
      }
      // ≥2 distinct group values → make sub-headers visible. The NULL bucket
      // ends up last under „Allgemein".
      const named = Array.from(buckets.entries())
        .filter(([k]) => k !== '__nogrp__')
        .sort(([a], [b]) => a.localeCompare(b, 'de'));
      const result: Array<{ groupLabel: string | null; rows: Workspace[] }> =
        named.map(([k, arr]) => ({
          groupLabel: k,
          rows: arr.sort((a, b) => a.label.localeCompare(b.label, 'de')),
        }));
      const fallback = buckets.get('__nogrp__');
      if (fallback && fallback.length > 0) {
        result.push({
          groupLabel: 'Allgemein',
          rows: fallback.sort((a, b) => a.label.localeCompare(b.label, 'de')),
        });
      }
      return result;
    };

    interface Section {
      name: string;
      subGroups: Array<{ groupLabel: string | null; rows: Workspace[] }>;
    }
    const result: Section[] = [];
    if (directRows.length > 0) {
      result.push({ name: 'Direkt', subGroups: buildSubGroups(directRows) });
    }
    for (const g of sortedGroups) {
      result.push({ name: g.name, subGroups: buildSubGroups(g.rows) });
    }
    return result;
  }, [visibleRows, effectiveOrgId]);

  // Flat list for keyboard nav — same order as the sections render.
  const flatVisible = useMemo<Workspace[]>(
    () => sections.flatMap((s) => s.subGroups.flatMap((g) => g.rows)),
    [sections],
  );

  // ESC + click-outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  // Reset/prime activeIndex whenever the list shape changes.
  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      // 2026-05-03: reset mode back to 'list' when the popover closes.
      setMode('list');
      return;
    }
    const selectedIdx = flatVisible.findIndex((w) => w.id === current.id);
    setActiveIndex(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, flatVisible, current.id]);

  // Autofocus search when opening.
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return;
  }, [open]);

  // Scroll the active row into view as the user arrows through.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelectorAll<HTMLElement>('[data-row]')[activeIndex];
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const handleSelect = useCallback(
    (id: string): void => {
      setWorkspace(id);
      setOpen(false);
      // Reset transient UI state so the next open starts fresh.
      setQuery('');
      triggerRef.current?.focus();
    },
    [setWorkspace],
  );

  const handleTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
    },
    [],
  );

  // Arrow-key / Enter handling on the search input + popover root.
  // We attach to the popover (not just search) so the list can be
  // navigated even after the user tabs to a filter chip.
  const handlePopoverKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = i + 1;
          return next >= flatVisible.length ? 0 : next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => {
          const next = i - 1;
          return next < 0 ? Math.max(0, flatVisible.length - 1) : next;
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setActiveIndex(Math.max(0, flatVisible.length - 1));
      } else if (e.key === 'Enter') {
        const target = flatVisible[activeIndex];
        if (target) {
          e.preventDefault();
          handleSelect(target.id);
        }
      }
    },
    [visibleRows, activeIndex, handleSelect],
  );

  const activeRowId =
    activeIndex >= 0 && activeIndex < flatVisible.length
      ? `topnav-ws-row-${flatVisible[activeIndex].id}`
      : undefined;

  return (
    <div className="topnav-ws">
      <button
        ref={triggerRef}
        type="button"
        className={`topnav-ws-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="topnav-ws-popover"
        aria-label={`Workspace: ${current.label}. Klicken zum Wechseln.`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span
          className={`topnav-ws-dot topnav-ws-dot--${current.accent}`}
          aria-hidden="true"
        />
        {/* Apple UX (2026-05-30): full workspace label with ellipsis instead of
            a 3-letter stub — on mobile too. Hierarchy instead of abbreviation. */}
        <span className="topnav-ws-trigger-label">{current.label}</span>
        <IconChevronDown className="topnav-ws-caret" size={12} />
      </button>

      {open ? (
        <div
          ref={popoverRef}
          id="topnav-ws-popover"
          className="topnav-ws-popover"
          role="dialog"
          aria-label="Workspace wählen"
          onKeyDown={handlePopoverKeyDown}
        >
          {mode === 'create' ? (
            <NewWorkspaceForm
              defaultOrgId={
                effectiveOrgId !== ORG_ALL_ID
                  ? effectiveOrgId
                  : userOrgs[0]?.id ?? ''
              }
              onCancel={() => setMode('list')}
              onSuccess={(ws) => {
                // Activate new workspace, refresh list, close popover.
                if (ws.id) setWorkspace(ws.id);
                setMode('list');
                setOpen(false);
                setQuery('');
              }}
            />
          ) : (
            <>
          <div className="topnav-ws-search-row">
            <input
              ref={searchRef}
              type="search"
              placeholder="Suchen …"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="topnav-ws-search"
              aria-label="Workspace suchen"
              aria-controls="topnav-ws-list"
              aria-activedescendant={activeRowId}
            />
          </div>

          <ul
            ref={listRef}
            id="topnav-ws-list"
            role="listbox"
            className="topnav-ws-list"
            aria-label="Workspaces gruppiert nach Organisation"
          >
            {(() => {
              let flatIdx = -1;
              return sections.map((section) => (
                <li key={section.name} className="topnav-ws-section-li">
                  {section.name ? (
                    <div className="topnav-ws-section">{section.name}</div>
                  ) : null}
                  {section.subGroups.map((sub, subIdx) => (
                    <div
                      key={`${section.name}-${sub.groupLabel ?? '__no__'}-${subIdx}`}
                    >
                      {sub.groupLabel ? (
                        <div className="topnav-ws-subgroup">
                          {sub.groupLabel}
                        </div>
                      ) : null}
                      <ul
                        role="group"
                        aria-label={
                          sub.groupLabel
                            ? `${section.name} · ${sub.groupLabel}`
                            : section.name || 'Workspaces'
                        }
                      >
                        {sub.rows.map((w) => {
                          flatIdx += 1;
                          const idx = flatIdx;
                          const selected = w.id === current.id;
                          const active = idx === activeIndex;
                          return (
                            <li key={w.id}>
                              <button
                                id={`topnav-ws-row-${w.id}`}
                                type="button"
                                data-row
                                className={`topnav-ws-item${selected ? ' is-active' : ''}${
                                  active ? ' is-focus' : ''
                                }`}
                                onClick={() => handleSelect(w.id)}
                                onMouseEnter={() => setActiveIndex(idx)}
                                role="option"
                                aria-selected={selected}
                                tabIndex={-1}
                              >
                                <span
                                  className={`topnav-ws-dot topnav-ws-dot--${w.accent}`}
                                  aria-hidden="true"
                                />
                                <span className="topnav-ws-item-body">
                                  <span className="topnav-ws-item-label">
                                    {w.label}
                                  </span>
                                  {w.meta ? (
                                    <span className="topnav-ws-item-meta">
                                      {w.meta}
                                    </span>
                                  ) : null}
                                </span>
                                {selected ? (
                                  <span
                                    className="topnav-ws-item-check"
                                    aria-hidden="true"
                                  >
                                    <IconCheck size={14} />
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </li>
              ));
            })()}
            {flatVisible.length === 0 ? (
              <li className="topnav-ws-empty" role="note">
                Keine Treffer.
              </li>
            ) : null}
          </ul>
          {/* 2026-05-03 — footer row "+ Neuer Workspace" within the same
              active org. Only visible when the user has a real org section
              (not in ORG_ALL mode). */}
          {effectiveOrgId !== ORG_ALL_ID || userOrgs[0] ? (
            <button
              type="button"
              className="topnav-ws-create-row"
              onClick={() => setMode('create')}
              aria-label="Neuen Workspace anlegen"
            >
              <span className="topnav-ws-create-row__plus" aria-hidden="true">
                <svg
                  width={14}
                  height={14}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              Neuer Workspace …
            </button>
          ) : null}
          {/* Edit link to the current workspace. Not the root, because there
              classic editing makes no sense. */}
          {current.id !== '__root__' ? (
            <a
              href={`/workspaces/${encodeURIComponent(current.id)}`}
              className="topnav-ws-edit-link"
              onClick={() => setOpen(false)}
            >
              Workspace bearbeiten →
            </a>
          ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default WorkspaceSwitcher;
