'use client';

/**
 * SystemPermissionsCard — the permission broker (owner directive 2026-06-03:
 * „das OSS soll sich solche Rechte selbst erfragen — extrem wichtig fürs
 * autonome Arbeiten").
 *
 * laz.ing detects missing system/browser permissions and REQUESTS them itself,
 * instead of letting the operator guess. Three classes:
 *
 *   1) Browser-grantable (the app calls the real request API):
 *        - notifications        Notification.requestPermission()
 *        - microphone (speech)  getUserMedia({audio}) → prompt, stop immediately
 *        - persistent storage   navigator.storage.persist()  (local-first!)
 *   2) Host-level (the browser CANNOT grant it → detect + guide):
 *        - routines backstop (macOS launchd + Full-Disk-Access) — steps +
 *          copy button, because a web app cannot trigger an FDA prompt.
 *
 * Pattern reused: the disclaimer-gated `AllAccessToggle` (workspace
 * permissions) and `lazing-policy-checker` (op gating) — this lifts the principle to
 * OS/browser capabilities. Styling: settings-hub-* classes (Apple-consistent).
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';

type Grant = 'granted' | 'prompt' | 'denied' | 'unknown' | 'host-action';

interface CapRow {
  key: string;
  label: string;
  why: string;
  grant: Grant;
  /** Action label, when requestable/actionable. */
  action?: string;
}

const PILL: Record<Grant, { cls: 'ready' | 'setup' | 'off'; text: string }> = {
  granted: { cls: 'ready', text: 'Erteilt' },
  prompt: { cls: 'setup', text: 'Anfragen' },
  denied: { cls: 'off', text: 'Blockiert' },
  unknown: { cls: 'setup', text: 'Unbekannt' },
  'host-action': { cls: 'setup', text: 'Aktion nötig' },
};

const FDA_STEPS =
  'macOS Routinen-Backstop (launchd) aktivieren:\n' +
  '1) System Settings → Datenschutz & Sicherheit → Festplattenvollzugriff\n' +
  '2) "+" → /bin/bash hinzufügen + aktivieren\n' +
  '3) Terminal: launchctl unload ~/Library/LaunchAgents/com.lazyos.routines-tick.plist 2>/dev/null; ' +
  'launchctl load ~/Library/LaunchAgents/com.lazyos.routines-tick.plist\n' +
  '(Bis dahin tickt der In-Process-Scheduler die Routinen, solange der Server läuft.)';

export function SystemPermissionsCard(): React.JSX.Element {
  const [notif, setNotif] = useState<Grant>('unknown');
  const [mic, setMic] = useState<Grant>('unknown');
  const [storage, setStorage] = useState<Grant>('unknown');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const detect = useCallback(async () => {
    // Benachrichtigungen
    if (typeof Notification !== 'undefined') {
      setNotif(
        Notification.permission === 'granted'
          ? 'granted'
          : Notification.permission === 'denied'
            ? 'denied'
            : 'prompt',
      );
    } else {
      setNotif('unknown');
    }
    // Microphone (the Permissions API is not available everywhere)
    try {
      const status = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      setMic(
        status.state === 'granted'
          ? 'granted'
          : status.state === 'denied'
            ? 'denied'
            : 'prompt',
      );
    } catch {
      setMic('prompt'); // not queryable → leave as requestable
    }
    // Persistent storage
    try {
      const persisted = await navigator.storage?.persisted?.();
      setStorage(persisted ? 'granted' : 'prompt');
    } catch {
      setStorage('unknown');
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const requestNotif = useCallback(async () => {
    if (typeof Notification === 'undefined') return;
    setBusy('notif');
    try {
      const r = await Notification.requestPermission();
      setNotif(r === 'granted' ? 'granted' : r === 'denied' ? 'denied' : 'prompt');
    } finally {
      setBusy(null);
    }
  }, []);

  const requestMic = useCallback(async () => {
    setBusy('mic');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop()); // release immediately — we only wanted the grant
      setMic('granted');
    } catch {
      setMic('denied');
    } finally {
      setBusy(null);
    }
  }, []);

  const requestStorage = useCallback(async () => {
    setBusy('storage');
    try {
      const ok = await navigator.storage?.persist?.();
      setStorage(ok ? 'granted' : 'prompt');
    } catch {
      setStorage('unknown');
    } finally {
      setBusy(null);
    }
  }, []);

  const copyFda = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(FDA_STEPS);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      /* Clipboard not available — the steps are in the text */
    }
  }, []);

  const rows: Array<CapRow & { onAction?: () => void }> = [
    {
      key: 'notif',
      label: 'Benachrichtigungen',
      why: 'Push für Gates, Fragen, Routinen-Briefs aufs Gerät.',
      grant: notif,
      action: notif === 'granted' ? undefined : 'Anfragen',
      onAction: requestNotif,
    },
    {
      key: 'mic',
      label: 'Mikrofon',
      why: 'Spracheingabe im Chat-Composer (Diktat).',
      grant: mic,
      action: mic === 'granted' ? undefined : 'Anfragen',
      onAction: requestMic,
    },
    {
      key: 'storage',
      label: 'Persistenter Speicher',
      why: 'Local-first: verhindert, dass der Browser Chat-Verlauf/Scope verdrängt.',
      grant: storage,
      action: storage === 'granted' ? undefined : 'Aktivieren',
      onAction: requestStorage,
    },
    {
      key: 'fda',
      label: 'Routinen-Backstop (macOS)',
      why: 'launchd-Timer für /api/routines/tick — braucht einmalig Full-Disk-Access.',
      grant: 'host-action',
      action: copied ? 'Kopiert ✓' : 'Schritte kopieren',
      onAction: copyFda,
    },
  ];

  // Overall status: ready when all browser-grantable ones are granted.
  const browserGrants = [notif, mic, storage];
  const overall: 'ready' | 'setup' | 'off' = browserGrants.every((g) => g === 'granted')
    ? 'ready'
    : browserGrants.some((g) => g === 'denied')
      ? 'off'
      : 'setup';
  const overallText =
    overall === 'ready'
      ? 'Alle erteilt'
      : `${browserGrants.filter((g) => g === 'granted').length}/3 erteilt`;

  return (
    <section
      id="permissions"
      data-testid="settings-section-permissions"
      className="settings-hub-card"
      aria-labelledby="permissions-title"
    >
      <header className="settings-hub-card-head">
        <div className="settings-hub-card-head-text">
          <h2 id="permissions-title" className="settings-hub-card-title">
            System-Berechtigungen
          </h2>
          <p className="settings-hub-card-desc">
            laz.ing fragt fehlende Rechte selbst an — für autonomes Arbeiten.
          </p>
        </div>
        <span
          className={`settings-hub-pill settings-hub-pill--${overall}`}
          data-testid={`settings-hub-pill-${overall}`}
        >
          <span className="settings-hub-pill-dot" aria-hidden="true" />
          {overallText}
        </span>
      </header>

      <div className="settings-hub-card-body">
        <ul style={listStyle}>
          {rows.map((r) => {
            const pill = PILL[r.grant];
            return (
              <li key={r.key} style={rowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={rowLabelStyle}>
                    {r.label}
                    <span
                      className={`settings-hub-pill settings-hub-pill--${pill.cls}`}
                      style={{ marginLeft: 8 }}
                    >
                      <span className="settings-hub-pill-dot" aria-hidden="true" />
                      {pill.text}
                    </span>
                  </div>
                  <div style={rowWhyStyle}>{r.why}</div>
                </div>
                {r.action ? (
                  <button
                    type="button"
                    onClick={r.onAction}
                    disabled={busy === r.key}
                    className="settings-hub-btn settings-hub-btn--ghost"
                    data-testid={`perm-action-${r.key}`}
                    style={{ flexShrink: 0 }}
                  >
                    {busy === r.key ? '…' : r.action}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {notif === 'denied' || mic === 'denied' ? (
          <p style={hintStyle}>
            Blockierte Rechte lassen sich nur in den Browser-/System-Einstellungen
            wieder freigeben — die App kann sie dann nicht erneut anfragen.
          </p>
        ) : null}
      </div>
    </section>
  );
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--s-3, 12px)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--s-3, 12px)',
  paddingBottom: 'var(--s-3, 12px)',
  borderBottom: '0.5px solid var(--line-2)',
};

const rowLabelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 4,
  fontSize: 14,
  color: 'var(--ink)',
  letterSpacing: '-0.01em',
};

const rowWhyStyle: CSSProperties = {
  marginTop: 3,
  fontSize: 12,
  color: 'var(--ink-3)',
  lineHeight: 1.45,
};

const hintStyle: CSSProperties = {
  marginTop: 'var(--s-3, 12px)',
  fontSize: 12,
  color: 'var(--ink-2)',
  lineHeight: 1.5,
};
