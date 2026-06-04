'use client';

/**
 * GitHubIndicator — TopNav-Pill, identical visual class to `.topnav-gear`.
 *
 * Lit (white) when the user has a GitHub credential bound, dimmed (zinc)
 * otherwise. Click → `/settings#github` (the GitHub section of the
 * settings hub, NOT a sub-page) so the user lands inside the unified
 * settings surface even if they haven't explored it yet.
 *
 * Server-known state is fetched once on mount via `/api/github/whoami`
 * (lazy-loaded — no network on every nav-render). We treat the absence
 * of `connected` as "not connected" — a 401 still rendered as "not
 * connected" (the user obviously CAN'T be auth'd if they got 401).
 *
 * Apple-minimal: single 18px GitHub-octocat outline glyph, accent-glow
 * only when connected (via `--a-now`).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface WhoamiResponse {
  connected?: boolean;
  login?: string | null;
}

export function GitHubIndicator(): React.JSX.Element {
  const [state, setState] = useState<{
    connected: boolean;
    login: string | null;
    loaded: boolean;
  }>({ connected: false, login: null, loaded: false });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/github/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : ({} as WhoamiResponse)))
      .then((data: WhoamiResponse) => {
        if (cancelled) return;
        setState({
          connected: !!data.connected,
          login: data.login ?? null,
          loaded: true,
        });
      })
      .catch(() => {
        if (!cancelled) setState({ connected: false, login: null, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = state.connected
    ? `GitHub verbunden${state.login ? ` als @${state.login}` : ''}. Klicken zum Verwalten.`
    : 'GitHub verbinden. Klicken um zu den Einstellungen zu springen.';

  return (
    <Link
      href="/settings#github"
      className="topnav-gear"
      aria-label={label}
      title={label}
      data-testid="topnav-github"
      data-connected={state.connected ? 'yes' : 'no'}
      style={{
        opacity: state.loaded ? 1 : 0.5,
        color: state.connected ? 'var(--a-now)' : 'var(--ink-3)',
      }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M12 2C6.48 2 2 6.58 2 12.22c0 4.5 2.87 8.32 6.85 9.67.5.1.68-.22.68-.49v-1.7c-2.78.6-3.37-1.35-3.37-1.35-.45-1.16-1.11-1.47-1.11-1.47-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.9 1.56 2.36 1.1 2.93.85.09-.66.35-1.1.63-1.36-2.22-.26-4.55-1.13-4.55-5.04 0-1.11.39-2.02 1.03-2.73-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.04A9.42 9.42 0 0 1 12 7.06c.85.004 1.7.12 2.5.34 1.9-1.31 2.74-1.04 2.74-1.04.55 1.41.2 2.45.1 2.71.64.71 1.03 1.62 1.03 2.73 0 3.92-2.34 4.78-4.57 5.03.36.32.68.94.68 1.91v2.82c0 .27.18.6.69.49C19.13 20.54 22 16.72 22 12.22 22 6.58 17.52 2 12 2z" />
      </svg>
    </Link>
  );
}

export default GitHubIndicator;
