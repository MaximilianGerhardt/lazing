'use client';

/**
 * AllAccessToggle — "Vollzugriff / All-Access" pill next to the engine pill.
 *
 * Owner directive (Maximilian Gerhardt, 2026-05-26, verbatim):
 *   „Wichtig ist, dass lazyOS hier wirklich lokalen Vollzugriff hat, wenn
 *    ermächtigt. Das ganze mit Warnhinweis. Könnte man unten in der Pill wo
 *    man Claude und Codex wechseln kann daneben stehen... oder togglebar mit
 *    Disclaimer den man akzeptieren muss... also der Vollzugriff-Modus /
 *    All-Access-Mode."
 *
 * What it does:
 *   - Sets ONLY the workspace permission mode. The live-chat spawn
 *     (server/workspace-session.ts → resolveChatToolAccess) reads this mode:
 *     on `freerein`/`freerein-with-audit` the agent gets full access
 *     (Bash, WebFetch, WebSearch + file edits); for everything else only
 *     safe file edits. So the toggle switches ON→`freerein`, OFF→`ask`.
 *   - The backend is done — this component is pure UI over
 *     GET + PATCH /api/permission/[workspaceId]/mode.
 *
 * Behavior:
 *   - Mount: GET the current mode → ON if freerein|freerein-with-audit, else OFF.
 *   - OFF→ON: disclaimer popover FIRST. Only after the risk confirmation
 *     (checkbox + "Vollzugriff aktivieren") → PATCH mode='freerein' → ON.
 *   - ON→OFF: direct PATCH mode='ask' → OFF (no disclaimer on deactivation).
 *   - Optimistic UI with rollback on error.
 *
 * Design signal (laz.ing Design Manifest v1.0):
 *   - The ON state DELIBERATELY does NOT use the lime brand gradient (--a-now =
 *     "positive/active"). Full access is a deliberately risky state →
 *     warn accent (--a-warn / amber, --a-danger in the disclaimer).
 *   - OFF = neutral/calm. Plain shield/lock SVG, no emojis.
 *   - Pitch-black canvas, round pill, 240ms cubic-bezier(0.16,1,0.3,1).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import type { PermissionMode } from '../../lib-v1/permission/settings/schema';
import { isRootWorkspace } from '../nav/workspaces-data';

interface Props {
  /** Workspace whose permission mode is toggled. */
  workspaceId: string;
  /** Optional: callback after a successful toggle (true = full access ON). */
  onChange?: (fullAccess: boolean) => void;
}

/** Modi, die als „Vollzugriff AN" gelten (server/workspace-session.ts-Parität). */
const FULL_ACCESS_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'freerein',
  'freerein-with-audit',
]);

/** Mode, der beim Aktivieren gesetzt wird (Vollzugriff). */
const MODE_ON: PermissionMode = 'freerein';
/** Mode, der beim Deaktivieren gesetzt wird (sicher, fragt nach). */
const MODE_OFF: PermissionMode = 'ask';

interface ModeResponse {
  mode?: string | null;
}

export function AllAccessToggle({
  workspaceId,
  onChange,
}: Props): React.JSX.Element | null {
  // Bug fix 2026-05-28 (owner report Tailscale console):
  //   `GET /api/permission/__root__/mode → 403` when opening the root view.
  //
  // Root cause: `__root__` is a virtual, cross-workspace ID
  // (`server/workspace-session.ts:94` ROOT_WORKSPACE_ID, `rootWorkspaceRow()`
  // synthesizes the row at runtime). It does not exist in the
  // `workspaces` table. `lib/security/permissions.ts:77-83` runs into
  // `ws.length === 0 → return null`; `canEditWorkspaceContent(null) → false`;
  // the route honestly answers with 403.
  //
  // Honest fix: the toggle is functionally meaningless for `__root__` anyway —
  // `resolveChatToolAccess` (`server/workspace-session.ts:133-154`) reads
  // `lazyos_permission_modes WHERE workspace_id = ?`; but the root view does not
  // route through this path at all, it goes through `buildRootSystemPrompt`. So
  // in root mode the toggle would only write a mode value into a virtual ID
  // that nothing reads.
  //
  // → We render NOTHING for `__root__` and fire no mount GET. The route
  //   stays unchanged (legitimate 403 semantics preserved). NO
  //   auth bypass, NO weakening of the permission gates.
  const synthetic = isRootWorkspace(workspaceId);

  // null = noch nicht geladen (Mount-GET pending) → Toggle ist neutral/disabled.
  const [fullAccess, setFullAccess] = useState<boolean | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Mount: read the current mode.
  //
  // Owner fix live test 2026-05-28 — system-wide user default.
  //   Hierarchy of truth (highest wins first):
  //     1. explicit workspace mode (GET /api/permission/<wsId>/mode → mode!=null)
  //     2. user default                  (GET /api/user/preferences → defaultPermissionMode)
  //     3. UI default                    (OFF / 'ask')
  //
  //   Effect: a freshly created workspace, in which the `lazyos_permission_modes`
  //   row was already seeded by the server from the user default (see
  //   POST /api/workspaces), shows the pill correctly right away. Should the
  //   seed not take for some reason (e.g. an older DB), the
  //   client fallback pulls the same truth from /api/user/preferences and raises
  //   the pill to ON as well.
  //
  //   Foreign workspaces (user is not a member → 403 on the mode GET) keep
  //   showing OFF — the user preference never reaches workspaces where
  //   no membership exists, because the pill in this path already ends at
  //   the first GET (403 → null → false), without consulting the default.
  useEffect(() => {
    if (synthetic) return;
    let cancelled = false;

    const readWorkspaceMode = async (): Promise<string | null | 'forbidden'> => {
      try {
        const r = await fetch(
          `/api/permission/${encodeURIComponent(workspaceId)}/mode`,
          { cache: 'no-store' },
        );
        // 401/403 = user may not read the mode (no membership).
        // In this case the pill MUST stay OFF — the user preference must
        // NOT leak as a mirror into a foreign workspace.
        if (r.status === 401 || r.status === 403) return 'forbidden';
        if (!r.ok) return null;
        const j = (await r.json()) as ModeResponse | null;
        return j?.mode ?? null;
      } catch {
        return null;
      }
    };

    const readUserDefault = async (): Promise<string | null> => {
      try {
        const r = await fetch('/api/user/preferences', { cache: 'no-store' });
        if (!r.ok) return null;
        const j = (await r.json()) as {
          defaultPermissionMode?: string | null;
        } | null;
        return j?.defaultPermissionMode ?? null;
      } catch {
        return null;
      }
    };

    void (async () => {
      const wsMode = await readWorkspaceMode();
      if (cancelled) return;
      if (wsMode === 'forbidden') {
        setFullAccess(false);
        return;
      }
      if (wsMode != null) {
        setFullAccess(FULL_ACCESS_MODES.has(wsMode));
        return;
      }
      // Workspace hat keinen expliziten Mode → User-Default konsultieren.
      const userDefault = await readUserDefault();
      if (cancelled) return;
      const on = userDefault != null && FULL_ACCESS_MODES.has(userDefault);
      setFullAccess(on);
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, synthetic]);

  // Close the disclaimer on an outside click.
  useEffect(() => {
    if (!showDisclaimer) return;
    const handler = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setShowDisclaimer(false);
        setRiskAccepted(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDisclaimer]);

  // PATCH-Schreiber mit optimistischem UI + Rollback.
  const writeMode = useCallback(
    async (mode: PermissionMode, optimistic: boolean): Promise<void> => {
      const previous = fullAccess;
      setBusy(true);
      setError(null);
      // Optimistic: sofort umschalten.
      setFullAccess(optimistic);
      try {
        const resp = await fetch(
          `/api/permission/${encodeURIComponent(workspaceId)}/mode`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode }),
          },
        );
        if (!resp.ok) {
          throw new Error(`mode-write-failed:${resp.status}`);
        }
        onChange?.(optimistic);
      } catch {
        // Rollback to the previous state.
        setFullAccess(previous);
        setError('Konnte den Modus nicht ändern. Bitte erneut versuchen.');
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, fullAccess, onChange],
  );

  // Klick auf die Pill.
  const onPillClick = useCallback(() => {
    if (busy || fullAccess === null) return;
    if (fullAccess) {
      // ON→OFF: direct, no disclaimer.
      void writeMode(MODE_OFF, false);
    } else {
      // AUS→AN: zuerst Disclaimer, KEIN sofortiges Schalten.
      setError(null);
      setRiskAccepted(false);
      setShowDisclaimer(true);
    }
  }, [busy, fullAccess, writeMode]);

  // Disclaimer confirmed → only now toggle.
  const confirmEnable = useCallback(() => {
    if (!riskAccepted) return;
    setShowDisclaimer(false);
    void writeMode(MODE_ON, true).then(() => setRiskAccepted(false));
  }, [riskAccepted, writeMode]);

  const cancelDisclaimer = useCallback(() => {
    setShowDisclaimer(false);
    setRiskAccepted(false);
  }, []);

  const isOn = fullAccess === true;
  const loading = fullAccess === null;

  // Bail-out for synthetic IDs (`__root__`). Placed AFTER all hooks so
  // the hook order stays stable across workspace switches — otherwise React #310
  // ("Rendered more hooks than during the previous render", owner report
  // 2026-05-28 console crash when switching between `__root__` and a real WS).
  if (synthetic) return null;

  return (
    <div
      ref={rootRef}
      style={containerStyle}
      data-test="all-access-root"
      data-full-access={isOn ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onPillClick}
        disabled={busy || loading}
        style={pillStyle(isOn, busy || loading)}
        aria-pressed={isOn}
        aria-label={
          isOn ? 'Vollzugriff deaktivieren' : 'Vollzugriff aktivieren'
        }
        title={
          isOn
            ? 'Vollzugriff ist AN — Agent darf Shell, Web und Dateien. Klick zum Deaktivieren.'
            : 'Vollzugriff ist AUS — sicherer Modus. Klick zum Aktivieren (mit Bestätigung).'
        }
        data-test="all-access-trigger"
      >
        {/* Phase C3 (UI/UX 2026-06-03): Icon-only Lock-Toggle — kein „Vollzugriff"-
            Text mehr auf der Composer-Zeile. Der Shield/Schloss-Glyph encodiert
            den Zustand via Form (zu/offen) + Warn-Farbe; aria-label/title tragen
            die Bedeutung. Ruhigere Zeile (Owner: „komplett zu viel"). */}
        <ShieldGlyph on={isOn} />
      </button>

      {showDisclaimer ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Vollzugriff aktivieren"
          style={disclaimerStyle}
          data-test="all-access-disclaimer"
        >
          <div style={disclaimerTitleRowStyle}>
            <WarnGlyph />
            <span style={disclaimerTitleStyle}>Vollzugriff aktivieren</span>
          </div>
          <p style={disclaimerBodyStyle}>
            In diesem Workspace darf der Agent dann Shell-Befehle ausführen
            (Bash), das Web abrufen (WebFetch / WebSearch) und Dateien ändern.
            Nur aktivieren, wenn du dem Vorgang vertraust.
          </p>

          <label style={riskRowStyle} data-test="all-access-risk-label">
            <input
              type="checkbox"
              checked={riskAccepted}
              onChange={(e) => setRiskAccepted(e.target.checked)}
              style={riskCheckboxStyle}
              data-test="all-access-risk-checkbox"
            />
            <span style={riskTextStyle}>Ich verstehe das Risiko.</span>
          </label>

          <div style={disclaimerActionsStyle}>
            <button
              type="button"
              onClick={cancelDisclaimer}
              style={secondaryBtnStyle}
              data-test="all-access-cancel"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={confirmEnable}
              disabled={!riskAccepted}
              style={primaryBtnStyle(riskAccepted)}
              data-test="all-access-confirm"
            >
              Vollzugriff aktivieren
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <span role="alert" style={errorStyle} data-test="all-access-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glyphs — schlichte SVGs, KEINE Emojis (Design Manifest v1.0)
// ---------------------------------------------------------------------------

function ShieldGlyph({ on }: { on: boolean }): React.JSX.Element {
  // AN = offenes Schloss (Zugriff offen) im Warn-Akzent; AUS = geschlossenes
  // Schild in neutralem Ton.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ color: on ? 'var(--a-warn, #FFD60A)' : 'var(--ink-3, #636366)' }}
    >
      {on ? (
        // Offenes Schloss
        <>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 7.5-2" />
        </>
      ) : (
        // Geschlossenes Schild
        <>
          <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
          <path d="M9.5 12l1.8 1.8L15 10" />
        </>
      )}
    </svg>
  );
}

function WarnGlyph(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ color: 'var(--a-danger, #FF453A)', flexShrink: 0 }}
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styles — Pitch-Black + Warn-Akzent (NICHT --a-now), 240ms cubic-bezier
// ---------------------------------------------------------------------------

const SPRING = 'cubic-bezier(0.16, 1, 0.3, 1)';

const containerStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
};

function pillStyle(on: boolean, disabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 34,
    minHeight: 34,
    padding: 7,
    borderRadius: 999,
    border: on
      ? '0.5px solid color-mix(in oklab, var(--a-warn, #FFD60A) 55%, var(--line-2, #1f1f1f))'
      : '0.5px solid var(--line-2, #1f1f1f)',
    // AN nutzt BEWUSST den amber Warn-Akzent, NICHT --a-now (lime = positiv).
    background: on
      ? 'color-mix(in oklab, var(--a-warn, #FFD60A) 12%, var(--sheet-2, #0e0e0e))'
      : 'var(--sheet-2, #0e0e0e)',
    color: on ? 'var(--a-warn, #FFD60A)' : 'var(--ink-2, #A1A1A6)',
    fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.01em',
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: `background 240ms ${SPRING}, border-color 240ms ${SPRING}, color 240ms ${SPRING}`,
  };
}

const disclaimerStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  right: 0,
  width: 300,
  padding: 16,
  borderRadius: 14,
  background: 'color-mix(in oklab, var(--sheet-2, #0e0e0e) 97%, transparent)',
  border: '0.5px solid color-mix(in oklab, var(--a-danger, #FF453A) 35%, var(--line-2, #1f1f1f))',
  boxShadow: '0 16px 36px rgba(0,0,0,0.5)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
};

const disclaimerTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const disclaimerTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--ink, #f5f5f5)',
  letterSpacing: '-0.01em',
};

const disclaimerBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--ink-2, #A1A1A6)',
};

const riskRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
};

const riskCheckboxStyle: CSSProperties = {
  width: 15,
  height: 15,
  accentColor: 'var(--a-danger, #FF453A)',
  cursor: 'pointer',
};

const riskTextStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink, #f5f5f5)',
};

const disclaimerActionsStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 2,
};

const secondaryBtnStyle: CSSProperties = {
  appearance: 'none',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  background: 'transparent',
  color: 'var(--ink-2, #A1A1A6)',
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
  fontSize: 12,
  fontWeight: 500,
  padding: '7px 12px',
  borderRadius: 999,
  cursor: 'pointer',
  transition: `background 240ms ${SPRING}, color 240ms ${SPRING}`,
};

function primaryBtnStyle(enabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    border: 'none',
    // Primary confirmation button in the danger accent (deliberately risky action).
    background: enabled
      ? 'var(--a-danger, #FF453A)'
      : 'color-mix(in oklab, var(--a-danger, #FF453A) 30%, var(--sheet-2, #0e0e0e))',
    color: enabled ? 'var(--ink, #f5f5f5)' : 'var(--ink-3, #636366)',
    fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
    fontSize: 12,
    fontWeight: 600,
    padding: '7px 14px',
    borderRadius: 999,
    cursor: enabled ? 'pointer' : 'not-allowed',
    transition: `background 240ms ${SPRING}, color 240ms ${SPRING}`,
  };
}

const errorStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  whiteSpace: 'nowrap',
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 10,
  letterSpacing: '0.02em',
  color: 'var(--a-danger, #FF453A)',
};
