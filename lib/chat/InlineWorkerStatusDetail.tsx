'use client';

/**
 * InlineWorkerStatusDetail — a focused detail view for the
 * InlineWorkerStatus pill.
 *
 * OWNER FINDING 2026-05-28 (verbatim):
 *   „Wenn ich auf die Pill drücke wo 18h 6m steht zum Beispiel […]
 *    dann öffnet sich mobil das Menü und scrollt mich zu den Workspaces.
 *    Das hatten wir bereits Mal aufgeschrieben, wurde nicht gefixt …
 *    Das bringt mir also nicht wirklich was…"
 *
 * Root:
 *   Previously the pill dispatched `lazyos:drawer:open` → the MobileDrawer
 *   opened fully → scrolled to #drawer-section-activity, directly
 *   above the workspaces section → the owner lost the chat context and
 *   landed visually in the workspaces list.
 *
 * Fix:
 *   A click opens this focused detail view INSTEAD of the drawer.
 *   Mobile (<640px): bottom sheet, desktop: popover under the pill.
 *   Content per activity: workstream title + step + duration + status +
 *   (if stuck) a stuck signal + „Zum Workstream springen" (Next.js link
 *   to /workstreams/[id] — NO drawer, NO scroll jump into other
 *   UI areas).
 *
 * Design requirements (laz.ing Design Manifest):
 *   - tokens only (no hex)
 *   - touch targets ≥ 44px
 *   - no horizontal overflow at 375px
 *   - no double background layer (Xcode-pure posture, ordered by the owner
 *     earlier in the session on 2026-05-28)
 *
 * Read-only — no mutation call. The data comes from the caller (the pill).
 */

import { useEffect, useRef } from 'react';
import { formatDur } from './format-duration';

export interface DetailActivityItem {
  type: 'workstream' | 'workflow' | 'routine' | 'sub-workstream';
  id: string;
  label: string;
  phase: string | null;
  lastTickMs: number | null;
  workspaceId: string;
  /** Optional: status marker for the detail surface (active|paused|stuck). */
  status?: 'active' | 'paused' | 'stuck' | null;
  /** Optional: seconds since the last event. Only relevant for 'stuck' items. */
  stuckSinceMs?: number | null;
  /** Optional: stuck signal in words (e.g. „kein Event seit 18h"). */
  stuckReason?: string | null;
}

interface Props {
  open: boolean;
  items: readonly DetailActivityItem[];
  now: number;
  onClose: () => void;
  /**
   * Optional: anchor rect of the pill (the desktop popover positions itself
   * below it). Mobile ignores it and renders a bottom sheet.
   */
  anchorRect?: DOMRect | null;
  /**
   * Click handler for „Zum Workstream springen". Default → Next.js
   * navigation via `href` in the link. The caller can override for tests.
   */
  onJumpToWorkstream?: (item: DetailActivityItem) => void;
}

const STUCK_HUMAN = (ms: number | null | undefined): string => {
  if (!ms || ms <= 0) return 'kein Heartbeat';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `kein Event seit ${min}m`;
  const h = Math.floor(min / 60);
  return `kein Event seit ${h}h ${min % 60}m`;
};

function statusLabel(status: DetailActivityItem['status']): string {
  if (status === 'stuck') return 'hängt';
  if (status === 'paused') return 'pausiert';
  if (status === 'active') return 'aktiv';
  return '';
}

function hrefFor(it: DetailActivityItem): string {
  switch (it.type) {
    case 'workstream':
    case 'sub-workstream':
      return `/workstreams/${encodeURIComponent(it.id)}`;
    case 'workflow':
      return `/workflows/${encodeURIComponent(it.id)}`;
    case 'routine':
      return `/routines/${encodeURIComponent(it.id)}`;
    default:
      return '/lanes';
  }
}

export function InlineWorkerStatusDetail({
  open,
  items,
  now,
  onClose,
  anchorRect,
  onJumpToWorkstream,
}: Props): React.JSX.Element | null {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Close on Esc + outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (sheetRef.current && sheetRef.current.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    // mousedown instead of click, so the pill click itself does not directly
    // close again (the pill onClick would otherwise pass through).
    window.addEventListener('mousedown', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDocClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  // Desktop anchor: by default BELOW the pill. Mobile: bottom sheet
  // (the CSS media query handles the positioning).
  //
  // 2026-05-29 (owner finding): when the pill sits far down in the viewport, the
  // downward-opened popover was off-screen/not viewable. Flip upwards:
  // if the space below the pill is not enough for the (max. ~60vh high) popover, AND
  // there is more space above → anchor at `bottom` (opens ABOVE the pill).
  const viewportH =
    typeof window !== 'undefined' ? window.innerHeight : 800;
  const spaceBelow = anchorRect != null ? viewportH - anchorRect.bottom : Infinity;
  const spaceAbove = anchorRect != null ? anchorRect.top : 0;
  // Estimated minimum height from which flipping makes sense (header + a few items).
  const NEEDED = 260;
  const placeUp =
    anchorRect != null && spaceBelow < NEEDED && spaceAbove > spaceBelow;

  const desktopStyle =
    anchorRect != null
      ? (placeUp
          ? ({
              // Anchor at the bottom edge of the pill, opening upwards.
              '--detail-anchor-bottom': `${viewportH - anchorRect.top + 8}px`,
              '--detail-anchor-left': `${anchorRect.left}px`,
            } as React.CSSProperties)
          : ({
              '--detail-anchor-top': `${anchorRect.bottom + 8}px`,
              '--detail-anchor-left': `${anchorRect.left}px`,
            } as React.CSSProperties))
      : undefined;

  const handleJump = (it: DetailActivityItem) => (e: React.MouseEvent) => {
    if (onJumpToWorkstream) {
      e.preventDefault();
      onJumpToWorkstream(it);
      onClose();
    } else {
      onClose();
    }
  };

  return (
    <div
      className="inline-worker-status-detail__backdrop"
      role="presentation"
      data-mounted="true"
    >
      <div
        ref={sheetRef}
        className="inline-worker-status-detail"
        role="dialog"
        aria-modal="true"
        aria-label="Hintergrund-Aktivitäten in diesem Workspace"
        data-placement={placeUp ? 'up' : 'down'}
        style={desktopStyle}
      >
        <span
          className="inline-worker-status-detail__handle"
          aria-hidden="true"
        />
        <header className="inline-worker-status-detail__head">
          <h2 className="inline-worker-status-detail__title">
            Hintergrund-Aktivitäten
          </h2>
          <button
            type="button"
            className="inline-worker-status-detail__close"
            aria-label="Schließen"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <ul
          className="inline-worker-status-detail__list"
          role="list"
        >
          {items.map((it) => {
            const dur = formatDur(it.lastTickMs, now);
            const status = statusLabel(it.status);
            const isStuck = it.status === 'stuck';
            const stuckText =
              it.stuckReason ??
              (isStuck ? STUCK_HUMAN(it.stuckSinceMs) : null);
            return (
              <li
                key={`${it.type}-${it.id}`}
                className="inline-worker-status-detail__item"
                data-status={it.status ?? undefined}
              >
                <div className="inline-worker-status-detail__row">
                  <span
                    className="inline-worker-status-detail__dot"
                    aria-hidden="true"
                    data-status={it.status ?? undefined}
                  />
                  <span
                    className="inline-worker-status-detail__label"
                    title={it.label}
                  >
                    {it.label}
                  </span>
                </div>
                <div className="inline-worker-status-detail__meta">
                  {it.phase ? (
                    <span className="inline-worker-status-detail__phase">
                      {it.phase}
                    </span>
                  ) : null}
                  {status ? (
                    <span
                      className="inline-worker-status-detail__status"
                      data-status={it.status ?? undefined}
                    >
                      {status}
                    </span>
                  ) : null}
                  {dur ? (
                    <span className="inline-worker-status-detail__dur">
                      · {dur}
                    </span>
                  ) : null}
                </div>
                {isStuck && stuckText ? (
                  <p className="inline-worker-status-detail__stuck-hint">
                    {stuckText}
                  </p>
                ) : null}
                <a
                  href={hrefFor(it)}
                  className="inline-worker-status-detail__jump"
                  data-jump-id={it.id}
                  onClick={handleJump(it)}
                >
                  Zum Workstream springen →
                </a>
              </li>
            );
          })}
          {items.length === 0 ? (
            <li className="inline-worker-status-detail__empty">
              Aktuell läuft nichts im Hintergrund.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

export default InlineWorkerStatusDetail;
