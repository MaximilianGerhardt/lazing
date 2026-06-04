'use client';

/**
 * InlineWorkerStatusDetail — fokussierte Detail-Sicht zur
 * InlineWorkerStatus-Pill.
 *
 * OWNER-BEFUND 2026-05-28 (verbatim):
 *   „Wenn ich auf die Pill drücke wo 18h 6m steht zum Beispiel […]
 *    dann öffnet sich mobil das Menü und scrollt mich zu den Workspaces.
 *    Das hatten wir bereits Mal aufgeschrieben, wurde nicht gefixt …
 *    Das bringt mir also nicht wirklich was…"
 *
 * Wurzel:
 *   Vorher dispatchte die Pill `lazyos:drawer:open` → MobileDrawer
 *   ging ganz auf → scrollte zu #drawer-section-activity, direkt
 *   ueber der Workspaces-Section → Owner verlor Chat-Kontext und
 *   landete optisch in der Workspaces-Liste.
 *
 * Fix:
 *   Klick oeffnet diese fokussierte Detail-Sicht ANSTELLE des Drawers.
 *   Mobile (<640px): Bottom-Sheet, Desktop: Popover unter der Pill.
 *   Inhalt pro Aktivitaet: Workstream-Titel + Step + Dauer + Status +
 *   (falls stuck) Stuck-Signal + „Zum Workstream springen" (Next.js Link
 *   nach /workstreams/[id] — KEIN Drawer, KEIN Scroll-Sprung in andere
 *   UI-Bereiche).
 *
 * Designvorgaben (laz.ing Design Manifest):
 *   - Tokens only (kein Hex)
 *   - Touch-Targets ≥ 44px
 *   - kein horizontales Overflow auf 375px
 *   - kein doppelter Hintergrund-Layer (Xcode-Pure-Posture, Owner
 *     2026-05-28 frueher in der Session schon befohlen)
 *
 * Read-only — kein Mutationsaufruf. Daten kommen vom Caller (Pill).
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
  /** Optional: Status-Marker fuer Detail-Surface (active|paused|stuck). */
  status?: 'active' | 'paused' | 'stuck' | null;
  /** Optional: Sekunden seit letztem Event. Nur fuer 'stuck'-Items relevant. */
  stuckSinceMs?: number | null;
  /** Optional: Stuck-Signal in Worten (z.B. „kein Event seit 18h"). */
  stuckReason?: string | null;
}

interface Props {
  open: boolean;
  items: readonly DetailActivityItem[];
  now: number;
  onClose: () => void;
  /**
   * Optional: anchor-Rect der Pill (Desktop-Popover positioniert sich
   * darunter). Mobile ignoriert das und rendert Bottom-Sheet.
   */
  anchorRect?: DOMRect | null;
  /**
   * Click-Handler fuer „Zum Workstream springen". Default → Next.js
   * navigation via `href` im Link. Caller kann override fuer Tests.
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

  // Esc + Outside-Click schliessen.
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
    // mousedown statt click, damit der Pill-Klick selbst nicht direkt
    // wieder schliesst (Pill-onClick wuerde sonst durchschlagen).
    window.addEventListener('mousedown', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDocClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  // Desktop-Anchor: standardmäßig UNTER der Pill. Mobile: bottom-sheet
  // (CSS-mediaquery uebernimmt die Positionierung).
  //
  // 2026-05-29 (Owner-Befund): Wenn die Pill weit unten im Viewport sitzt, war
  // das nach unten geöffnete Popover off-screen/nicht einsehbar. Flip-nach-oben:
  // reicht der Platz unter der Pill nicht für das (max. ~60vh hohe) Popover, UND
  // ist oberhalb mehr Platz → am `bottom` ankern (öffnet ÜBER der Pill).
  const viewportH =
    typeof window !== 'undefined' ? window.innerHeight : 800;
  const spaceBelow = anchorRect != null ? viewportH - anchorRect.bottom : Infinity;
  const spaceAbove = anchorRect != null ? anchorRect.top : 0;
  // Geschätzte Mindesthöhe, ab der Flippen sinnvoll ist (Header + ein paar Items).
  const NEEDED = 260;
  const placeUp =
    anchorRect != null && spaceBelow < NEEDED && spaceAbove > spaceBelow;

  const desktopStyle =
    anchorRect != null
      ? (placeUp
          ? ({
              // Ankern am unteren Rand der Pill nach oben hin.
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
