'use client';

/**
 * OrgSwitcher — Phase A.
 *
 * Its own pill to the left of the WorkspaceSwitcher. Clicking opens a popover
 * with the user's orgs, plus "Alle" (no filter). The selection persists in
 * `lazyos.org` (localStorage) and filters the WorkspaceSwitcher.
 *
 * Layout: same height as WorkspaceSwitcher, but glyph instead of color dot.
 * When space is tight on mobile: only the 3-letter slug (LLC, BUDD, …).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { usePathname } from 'next/navigation';

import { IconCheck, IconChevronDown, IconChevronRight, IconSubtree } from './icons';
import {
  ORG_ALL_ID,
  useCurrentOrgId,
  useCurrentWorkspace,
  useSetOrg,
  useUserOrgs,
  useWorkspaces,
} from './hooks';
import { isVirtualWorkspaceId } from './workspaces-data';

interface OrgRowProps {
  id: string;
  name: string;
  type?: string;
  paletteIndex?: number;
  isCurrent: boolean;
  isChild?: boolean;
  onPick: () => void;
}

function OrgRow({
  name,
  type,
  paletteIndex,
  isCurrent,
  isChild,
  onPick,
}: OrgRowProps): React.JSX.Element {
  const className = [
    'org-row',
    isCurrent ? 'is-current' : '',
    isChild ? 'is-child' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      onClick={onPick}
      className={className}
      role="option"
      aria-selected={isCurrent}
    >
      {isChild ? (
        <span className="org-row-tree" aria-hidden>
          <IconSubtree size={12} />
        </span>
      ) : null}
      <span
        className="org-row-dot"
        aria-hidden
        style={
          paletteIndex !== undefined
            ? { background: `var(--palette-${paletteIndex}, var(--a-now))` }
            : undefined
        }
      />
      <span className="org-row-text">
        <span className="org-row-name">{name}</span>
        {type ? <span className="org-row-type">{type}</span> : null}
      </span>
      {isCurrent ? (
        <span className="org-row-check" aria-hidden>
          <IconCheck size={14} />
        </span>
      ) : null}
    </button>
  );
}

export function OrgSwitcher(): React.JSX.Element {
  const { orgs, isLoading } = useUserOrgs();
  const currentOrgId = useCurrentOrgId();
  const setOrg = useSetOrg();
  const pathname = usePathname() ?? '/';
  // Nav-Fix D (2026-06-02): On real workspace pages (/workspaces/[id]/*)
  // <OrgBootstrap> owns the org context. The auto-normalization must NOT
  // "correct" via a hard redirect here — otherwise it leaves the page
  // (the old blocker). The user-initiated pick() handler stays untouched,
  // so the org switch keeps working.
  const isRealWorkspacePage = /^\/workspaces\/[^/]+(?:\/|$)/.test(pathname);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const current = useMemo(
    () => orgs.find((o) => o.id === currentOrgId) ?? null,
    [orgs, currentOrgId],
  );

  // P4-SPINE (2026-06-02): pure reads of existing hooks for the scope spine.
  // Both are unconditional and placed BEFORE the auto-normalization effect /
  // any early return, so the P1 nav-fix guard is untouched. They feed the
  // quiet breadcrumb (Kunde › Workspace) that reflects the current scope.
  const currentWorkspace = useCurrentWorkspace();
  const { workspaces } = useWorkspaces();

  /**
   * Derive the scope crumb (memoized). Two scopes:
   *  - org-root (virtual workspace id `__org_root__:*` / `__root__`): the
   *    crumb is the Kunde name only, or the literal "Hauptchat" when no
   *    Kunde resolves (cross-workspace `__root__`). One segment, no separator.
   *  - real customer workspace: resolve the owning Kunde; if that Kunde has
   *    ≤1 visible workspace the single workspace IS the customer ⇒ collapse to
   *    `<Kunde>` only. If ≥2 ⇒ `<Kunde> › <Workspace>`.
   *
   * `segments[i].stepUpOrgId` is set only on a non-leaf Kunde prefix in the
   * 2-segment case — that segment becomes a step-up affordance (S4).
   * `flat` is the screen-reader / title path string built in parallel.
   */
  const crumb = useMemo<{
    segments: Array<{ key: string; text: string; isLeaf: boolean; stepUpOrgId?: string }>;
    flat: string;
  }>(() => {
    const atOrgRoot = isVirtualWorkspaceId(currentWorkspace.id);
    if (atOrgRoot) {
      // Kunde name at org-root, else the literal "Hauptchat" (e.g. __root__
      // cross-workspace, or while orgs are still loading).
      const label = current?.name || 'Hauptchat';
      return {
        segments: [{ key: 'root', text: label, isLeaf: true }],
        flat: label,
      };
    }

    // Scoped into a real customer workspace.
    const owningOrg =
      currentWorkspace.organization ??
      orgs.find((o) => o.id === currentWorkspace.organizationId) ??
      current ??
      null;
    const owningOrgId = owningOrg?.id ?? currentWorkspace.organizationId ?? undefined;
    const kundeName = owningOrg?.name ?? current?.name ?? 'Kunde wählen';

    // Workspace count for that Kunde — the collapse signal. Exclude archived
    // + every virtual/aggregate id so a single REAL workspace reads as one row.
    const wsCount = owningOrgId
      ? workspaces.filter(
          (w) =>
            w.organizationId === owningOrgId &&
            !w.archived &&
            !isVirtualWorkspaceId(w.id) &&
            w.id !== '__root__' &&
            !w.id.startsWith('__org_root__:'),
        ).length
      : 0;

    if (wsCount <= 1) {
      // Collapse — the single workspace IS the customer.
      return {
        segments: [{ key: 'kunde', text: kundeName, isLeaf: true }],
        flat: kundeName,
      };
    }

    // ≥2 workspaces — show Kunde › Workspace; the Kunde prefix steps up.
    const wsLabel = currentWorkspace.label || 'Workspace';
    return {
      segments: [
        { key: 'kunde', text: kundeName, isLeaf: false, stepUpOrgId: owningOrgId },
        { key: 'workspace', text: wsLabel, isLeaf: true },
      ],
      flat: `${kundeName} › ${wsLabel}`,
    };
  }, [currentWorkspace, current, orgs, workspaces]);

  // Step-up handler (S4): switch to a Kunde's org-root WITHOUT opening the
  // popover. `setOrg` already hard-navigates to /orgs/<id>/chat = Hauptchat.
  const stepUp = useCallback(
    (orgId: string) => {
      setOrg(orgId);
    },
    [setOrg],
  );

  /**
   * Build the hierarchy in 2 levels:
   *  - `topLevel` = orgs without a `parentId` OR whose parent is not in the list
   *    (with a restricted user scope the parent may be missing).
   *  - `childrenByParent` = map parentId → sub-orgs.
   *
   * Sorting: stable by `name`. We don't necessarily respect the server order,
   * but `name` is the only stable cross-session order the user recognizes.
   */
  const { topLevel, childrenByParent } = useMemo(() => {
    const ids = new Set(orgs.map((o) => o.id));
    const tops = orgs.filter((o) => !o.parentId || !ids.has(o.parentId));
    const childMap = new Map<string, typeof orgs>();
    for (const o of orgs) {
      if (o.parentId && ids.has(o.parentId)) {
        const list = childMap.get(o.parentId);
        if (list) {
          (list as unknown as Array<typeof o>).push(o);
        } else {
          childMap.set(o.parentId, [o] as unknown as typeof orgs);
        }
      }
    }
    const byName = (a: { name: string }, b: { name: string }): number =>
      a.name.localeCompare(b.name);
    const topsSorted = [...tops].sort(byName);
    const childMapSorted = new Map<string, typeof orgs>();
    for (const [k, v] of childMap.entries()) {
      childMapSorted.set(k, [...v].sort(byName) as unknown as typeof orgs);
    }
    return { topLevel: topsSorted, childrenByParent: childMapSorted };
  }, [orgs]);

  // Phase IA.1 — when no valid org is stored (first login or an
  // old ORG_ALL_ID session) OR the user is no longer a member of the
  // target org, automatically switch to the first available user org.
  useEffect(() => {
    if (isLoading) return;
    if (orgs.length === 0) return;
    if (isRealWorkspacePage) return;
    const valid = orgs.some((o) => o.id === currentOrgId);
    if (currentOrgId === ORG_ALL_ID || !valid) {
      setOrg(orgs[0]!.id);
    }
  }, [currentOrgId, orgs, isLoading, setOrg, isRealWorkspacePage]);

  // ESC + click-outside
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

  const pick = useCallback(
    (id: string) => {
      setOrg(id);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [setOrg],
  );

  // FLAT string form of the crumb for SR / hover — e.g. "North › Demo Fitness"
  // or "Hauptchat" — so the full scope path is announced even though the
  // visual segments may ellipsize. (Vocabulary lock: "Kunde", not "Org".)
  const triggerLabel = crumb.flat || (current?.name ?? 'Kunde wählen');

  return (
    <div className="topnav-org">
      <button
        ref={triggerRef}
        type="button"
        className="topnav-org-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Kontext: ${triggerLabel}. Tippen zum Wechseln.`}
        title={`Kontext: ${triggerLabel} — tippen zum Wechseln`}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="topnav-org-dot"
          aria-hidden
          style={
            current
              ? { background: `var(--palette-${current.paletteIndex}, var(--a-now))` }
              : undefined
          }
        />
        {/* P4-SPINE (2026-06-02): the eyebrow is now a QUIET scope breadcrumb
            that reflects the current scope (Kunde › Workspace). It stays the
            same trigger button — relabeled content, not a second control. The
            Kunde prefix (non-leaf) steps up to that Kunde's Hauptchat; the leaf
            + the rest of the trigger keep the popover-toggle. Token-only inline
            styles so app/components.css (owned by neither slice) is untouched;
            the wrapper keeps `.topnav-org-trigger-label` for its ellipsis +
            responsive max-width rules. */}
        <span
          className="topnav-org-trigger-label"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}
        >
          {crumb.segments.map((seg, i) => {
            const segStyle: CSSProperties = {
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: seg.isLeaf ? 'var(--ink-2)' : 'var(--ink-3)',
            };
            const isStepUp = !seg.isLeaf && Boolean(seg.stepUpOrgId);
            return (
              <span
                key={seg.key}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}
              >
                {i > 0 ? (
                  <span
                    className="topnav-org-crumb-sep"
                    aria-hidden
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      color: 'var(--ink-3)',
                      flexShrink: 0,
                    }}
                  >
                    <IconChevronRight size={12} />
                  </span>
                ) : null}
                {isStepUp ? (
                  // Step-up affordance — switch to this Kunde's Hauptchat
                  // without opening the popover. role=link + Enter/Space; we
                  // stopPropagation so the trigger's popover-toggle does not
                  // also fire. Not a nested <button> (invalid inside a button).
                  <span
                    role="link"
                    tabIndex={0}
                    title={`Zu Hauptchat von ${seg.text}`}
                    aria-label={`Zu Hauptchat von ${seg.text}`}
                    style={{ ...segStyle, cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      stepUp(seg.stepUpOrgId!);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        stepUp(seg.stepUpOrgId!);
                      }
                    }}
                  >
                    {seg.text}
                  </span>
                ) : (
                  <span
                    className={seg.isLeaf ? 'is-leaf' : undefined}
                    style={segStyle}
                  >
                    {seg.text}
                  </span>
                )}
              </span>
            );
          })}
        </span>
        <IconChevronDown size={12} className="topnav-org-caret" />
      </button>

      {/* Apple reduction (2026-05-30): the edit pencil next to the switcher is
          removed — one of the surplus bar targets flagged by the render critic
          (HIGH). Org editing now runs exclusively through the
          hamburger drawer (Organisation → „Aktive Organisation" /orgs +
          „Organisationen verwalten" /orgs/manage) or the org popover below.
          The identity line stays the calm primary anchor. */}

      {open ? (
        <div
          ref={popoverRef}
          className="topnav-org-popover"
          role="listbox"
          aria-label="Kunden"
        >
          {/* Phase IA.1 — no more "all orgs" mode (user decision
              2026-04-29). Only the real user orgs as choices.
              2026-05-01 — 2-level hierarchy: top-level + sub-orgs as
              indented items under their parent. */}
          {topLevel.map((o) => {
            const children = childrenByParent.get(o.id);
            return (
              <div key={o.id} className="topnav-org-group">
                <OrgRow
                  id={o.id}
                  name={o.name}
                  type={o.type}
                  paletteIndex={o.paletteIndex}
                  isCurrent={currentOrgId === o.id}
                  onPick={() => pick(o.id)}
                />
                {children
                  ? children.map((child) => (
                      <OrgRow
                        key={child.id}
                        id={child.id}
                        name={child.name}
                        type={child.type}
                        paletteIndex={child.paletteIndex}
                        isCurrent={currentOrgId === child.id}
                        isChild
                        onPick={() => pick(child.id)}
                      />
                    ))
                  : null}
              </div>
            );
          })}
          {orgs.length === 0 && !isLoading ? (
            <div className="topnav-org-empty">Keine Kunden.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
