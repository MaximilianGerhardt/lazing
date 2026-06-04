'use client';

/**
 * StatusCluster — a single status pill for the mobile TopNav.
 *
 * 2026-05-03 wave B — Apple-pure mobile density cut.
 *
 * Aggregates four indicators (Tpm + Observatory + Activity + Push) into
 * a single glance pill:
 *
 *   - idle     -> ~6px dot in var(--ink-3) (calm, no "dust"), no outline
 *   - running  -> dot var(--a-now) + subtle 1px pill outline
 *   - warn     -> dot var(--a-warn) + pulse animation 1.4s loop
 *   - error    -> dot var(--a-danger) + pulse
 *
 * Tap surface: >=44×44 (a11y) — enforced as wrapper min-sizing on the TSX side;
 * the visible dot stays ~6px (box in components.css).
 *
 * A tap opens a status sheet (same mechanics as SessionControls — bottom
 * sheet on mobile, popover on desktop) with the 4 sub-indicators as rows
 * and their existing detail components (TpmIndicator/ObservatoryIndicator/
 * BackgroundActivityIndicator/PushToggle reused — no reimplement).
 *
 * Polling hooks are not created twice: each sub-component does its own
 * polling. Here we additionally poll only the two top-level values
 * (activity + observatory) to determine the severity — lightweight.
 *
 * Tokens-only, no inline hex.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { TpmIndicator } from './TpmIndicator';
import { ObservatoryIndicator } from './ObservatoryIndicator';
import { BackgroundActivityIndicator } from './BackgroundActivityIndicator';
import { PushToggle } from './PushToggle';
import { AutoModeToggle } from './AutoModeToggle';
import { CompactButton } from './CompactButton';

// ───────────────────────────────────────────────────────────────────────────
//  Severity probe (lightweight — the sub-components poll separately).
// ───────────────────────────────────────────────────────────────────────────

type Severity = 'idle' | 'running' | 'warn' | 'error';

interface ProbeResult {
  severity: Severity;
  /** Description for aria/title. */
  summary: string;
}

const PROBE_INTERVAL_MS = 30_000;

async function probeStatus(signal: AbortSignal): Promise<ProbeResult> {
  // Best-effort: two parallel calls. If one fails, fall back to idle.
  try {
    const [actRes, hbRes] = await Promise.all([
      fetch('/api/activity/live', { cache: 'no-store', signal }).catch(
        () => null,
      ),
      fetch('/api/heartbeat/status', { cache: 'no-store', signal }).catch(
        () => null,
      ),
    ]);

    let running = 0;
    let stuck = 0;
    let warn = 0;
    let error = 0;

    if (actRes?.ok) {
      const json = (await actRes.json().catch(() => ({}))) as {
        running?: number;
        stuck?: number;
      };
      running = json.running ?? 0;
      stuck = json.stuck ?? 0;
    }
    if (hbRes?.ok) {
      const json = (await hbRes.json().catch(() => ({}))) as {
        globals?: { stale?: number; dormant?: number; error?: number };
      };
      warn = (json.globals?.stale ?? 0) + (json.globals?.dormant ?? 0);
      error = json.globals?.error ?? 0;
    }

    let severity: Severity = 'idle';
    if (error > 0 || stuck > 0) severity = 'error';
    else if (warn > 0) severity = 'warn';
    else if (running > 0) severity = 'running';

    const parts: string[] = [];
    if (running > 0) parts.push(`${running} laufend`);
    if (stuck > 0) parts.push(`${stuck} blockiert`);
    if (warn > 0) parts.push(`${warn} stale`);
    if (error > 0) parts.push(`${error} Fehler`);
    const summary = parts.length > 0 ? parts.join(', ') : 'alles ruhig';

    return { severity, summary };
  } catch {
    return { severity: 'idle', summary: 'Status nicht erreichbar' };
  }
}

// ───────────────────────────────────────────────────────────────────────────
//  Component.
// ───────────────────────────────────────────────────────────────────────────

interface StatusClusterProps {
  vapidPublicKey?: string;
}

export function StatusCluster({
  vapidPublicKey = '',
}: StatusClusterProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [probe, setProbe] = useState<ProbeResult>({
    severity: 'idle',
    summary: 'Status lädt …',
  });
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const sheetId = useId();

  // Probe polling (lightweight — the detail indicators poll separately).
  useEffect(() => {
    let cancelled = false;
    const ctrlRef: { current: AbortController | null } = { current: null };
    const tick = (): void => {
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      void probeStatus(ctrl.signal).then((next) => {
        if (cancelled) return;
        setProbe(next);
      });
    };
    tick();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, PROBE_INTERVAL_MS);
    const onVis = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      ctrlRef.current?.abort();
    };
  }, []);

  const closeSheet = useCallback(() => setOpen(false), []);
  const openSheet = useCallback(() => {
    previouslyFocused.current = document.activeElement;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        top: Math.round(rect.bottom + 6),
        right: Math.max(8, Math.round(window.innerWidth - rect.right)),
      });
    }
    setOpen(true);
  }, []);

  // ESC + Tab-Trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSheet();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = sheetRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeSheet]);

  // Restore-Focus on close.
  useEffect(() => {
    if (open) return;
    if (previouslyFocused.current instanceof HTMLElement) {
      previouslyFocused.current.focus();
    }
  }, [open]);

  const { severity, summary } = probe;
  const ariaLabel = `Status — ${summary}. Tippen für Details.`;

  // TSX-side guarantees (P1): the visible dot stays ~6px (painted in
  // components.css), but the *tap surface* must be >=44×44 regardless of the
  // CSS-agent's box. We enforce that via wrapper min-sizing here — no CSS
  // duplication, just a floor on the interactive button. Idle/all-calm dot
  // reads as calm (var(--ink-3)), not dust (var(--line-2)); the active-severity
  // colors stay owned by components.css.
  const isCalm = severity === 'idle';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeSheet() : openSheet())}
        className="status-cluster"
        data-severity={severity}
        data-state={open ? 'open' : 'closed'}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={sheetId}
        title={ariaLabel}
        style={{ minWidth: 44, minHeight: 44 }}
      >
        <span
          className="status-cluster__dot"
          aria-hidden="true"
          style={isCalm ? { background: 'var(--ink-3)' } : undefined}
        />
      </button>

      {open ? (
        <div
          className="status-cluster-sheet-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeSheet();
          }}
          role="presentation"
        >
          <div
            ref={sheetRef}
            id={sheetId}
            className="status-cluster-sheet"
            role="menu"
            aria-modal="true"
            aria-label="System-Status"
            style={
              anchor
                ? ({
                    '--popover-anchor-top': `${anchor.top}px`,
                    '--popover-anchor-right': `${anchor.right}px`,
                  } as CSSProperties)
                : undefined
            }
          >
            <span className="status-cluster-sheet__handle" aria-hidden="true" />
            <h2 className="status-cluster-sheet__title">Status</h2>

            <div className="status-cluster-sheet__summary">
              <span
                className="status-cluster__dot"
                data-severity={severity}
                aria-hidden="true"
              />
              <span>{summary}</span>
            </div>

            <ul className="status-cluster-sheet__list" role="none">
              <SheetRow label="Token-Budget (TPM)" hint="Verbrauch des MAX-Plan-Buckets">
                <TpmIndicator />
              </SheetRow>
              <SheetRow label="Hintergrund-Aktivität" hint="Laufende Workstreams + Cron">
                <BackgroundActivityIndicator />
              </SheetRow>
              <SheetRow label="Observatory" hint="Heartbeat aller Workspaces">
                <ObservatoryIndicator />
              </SheetRow>
              <SheetRow label="Push-Benachrichtigungen" hint="iOS / Browser">
                <PushToggle vapidPublicKey={vapidPublicKey} />
              </SheetRow>
              <SheetRow label="Auto-Mode" hint="Spawn-Dispatch automatisch nach Plan-Approval">
                <AutoModeToggle />
              </SheetRow>
              <SheetRow label="Verlauf kompaktieren" hint="Alle Workspaces — Server-Snapshot">
                <CompactButton />
              </SheetRow>
            </ul>

            <button
              type="button"
              className="status-cluster-sheet__cancel"
              onClick={closeSheet}
              aria-label="Schließen"
            >
              Schließen
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

interface SheetRowProps {
  label: string;
  hint: string;
  children: ReactNode;
}

function SheetRow({ label, hint, children }: SheetRowProps): React.JSX.Element {
  return (
    <li className="status-cluster-sheet__row" role="none">
      <div className="status-cluster-sheet__row-body">
        <span className="status-cluster-sheet__row-label">{label}</span>
        <span className="status-cluster-sheet__row-hint">{hint}</span>
      </div>
      <div className="status-cluster-sheet__row-action">{children}</div>
    </li>
  );
}

export default StatusCluster;
