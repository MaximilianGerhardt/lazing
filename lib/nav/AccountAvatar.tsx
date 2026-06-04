'use client';

/**
 * AccountAvatar — TopNav avatar pill with dropdown menu.
 *
 * Click → opens a Apple-minimal menu with:
 *   - Account-Email (read-only header)
 *   - "Einstellungen" → /settings
 *   - "Onboarding neu starten" → /oss-onboarding (visible but no URL hint)
 *   - "Abmelden"
 *
 * Initial-Letter circle (first char of email/displayName), pitch-black
 * background with subtle hairline. Menu dismisses on outside-click,
 * Escape-key, or any menu-item activation.
 *
 * Server-known state arrives via `/api/auth/me` (lightweight). If the
 * call fails, the avatar falls back to a generic "U" glyph but stays
 * clickable so the user can still sign out / open settings.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

interface MeUser {
  id?: string;
  email?: string | null;
  displayName?: string | null;
}

interface MeResponse {
  user?: MeUser;
}

export function AccountAvatar(): React.JSX.Element {
  const [me, setMe] = useState<MeUser | null>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: MeResponse | null) => {
        if (!cancelled) setMe(data?.user ?? null);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Outside-click + Escape dismiss.
  // Note: we attach the mousedown-listener on the *next* tick after `open`
  // becomes true, otherwise the same click that opened the menu (which
  // bubbles to `window`) immediately closes it. requestAnimationFrame
  // delays the binding until after React has committed the open state.
  useEffect(() => {
    if (!open) return;
    let attached = false;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    const raf = requestAnimationFrame(() => {
      window.addEventListener('mousedown', onDoc);
      attached = true;
    });
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      if (attached) window.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login');
    } catch {
      setSigningOut(false);
    }
  }, []);

  const label = me?.displayName ?? me?.email ?? 'Account';
  const initial = ((me?.displayName ?? me?.email ?? 'U').trim().charAt(0) || 'U').toUpperCase();

  return (
    <div
      ref={wrapRef}
      className="topnav-account"
      style={{ position: 'relative', display: 'inline-flex' }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="topnav-gear"
        aria-label={`Account-Menü öffnen (${label})`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="topnav-account"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.02em',
        }}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account-Menü"
          data-testid="topnav-account-menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 240,
            background: 'var(--card)',
            border: '0.5px solid var(--line-2)',
            borderRadius: 12,
            padding: 8,
            zIndex: 1000,
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
          }}
        >
          <div
            style={{
              padding: '8px 10px 10px',
              borderBottom: '0.5px solid var(--line-2)',
              marginBottom: 6,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </div>
            {me?.email && me?.displayName && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--ink-3)',
                  fontFamily: 'var(--font-mono)',
                  marginTop: 2,
                }}
              >
                {me.email}
              </div>
            )}
          </div>

          {/* Redundancy cut (UI/UX audit 2026-06-03): Settings/Engines
              live canonically in the drawer (mobile) / OverflowMenu (desktop) / Cmd+K.
              The avatar menu is now pure identity + onboarding + logout
              (Apple pattern). */}
          <Link
            href="/oss-onboarding"
            onClick={() => setOpen(false)}
            role="menuitem"
            data-testid="account-menu-restart-onboarding"
            style={menuItemStyle}
          >
            Onboarding neu starten
          </Link>
          {process.env.NODE_ENV === 'development' && (
            <Link
              href="/design"
              onClick={() => setOpen(false)}
              role="menuitem"
              data-testid="account-menu-design"
              style={menuItemStyle}
            >
              Design-Bibliothek
            </Link>
          )}
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            role="menuitem"
            data-testid="account-menu-signout"
            style={{
              ...menuItemStyle,
              width: '100%',
              textAlign: 'left',
              background: 'transparent',
              border: 'none',
              color: 'var(--a-danger, #ef4444)',
              cursor: signingOut ? 'wait' : 'pointer',
              borderTop: '0.5px solid var(--line-2)',
              marginTop: 4,
              paddingTop: 10,
            }}
          >
            {signingOut ? 'Melde ab …' : 'Abmelden'}
          </button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'block',
  padding: '8px 10px',
  borderRadius: 8,
  fontSize: 13,
  color: 'var(--ink-2)',
  textDecoration: 'none',
  fontFamily: 'inherit',
};

export default AccountAvatar;
