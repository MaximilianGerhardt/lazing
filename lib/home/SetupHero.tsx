'use client';

/**
 * SetupHero — first-time-user setup banner + Setup-Cards.
 *
 * Rendered above the chat when ANY of the following is true:
 *   - No engine probed available (Engines-card lit)
 *   - No push subscription / VAPID missing (Push-card lit)
 *
 * GitHub-optional directive 2026-05-23: The GitHub-card is NO LONGER part
 * of the default setup flow. lazyOS works fully without GitHub — Chat,
 * Workspaces, Engines, Push all run standalone. A GitHub-card is only
 * rendered if the user already opted-in earlier (cookie / localStorage
 * flag `lazyos.setup.show-github`). Otherwise the user finds GitHub in
 * Settings whenever they actually want it.
 *
 * Cards link DIRECTLY to the matching `/settings#…` anchor — the user
 * never sees a typed URL, just clicks the card. The hero collapses to
 * nothing once all required cards are green (no flash on subsequent
 * renders, because the "ready" state is cached in localStorage for
 * 60 minutes).
 *
 * Apple-minimal Jobs/Rams discipline:
 *   - One sentence headline
 *   - Cards 3-up on desktop, stacked on mobile
 *   - Brand-gradient ONLY on the primary CTA of the most-urgent card
 *   - No emoji, no exclamation marks, no marketing copy
 *
 * The Setup-Hero is mounted at the TOP of the home page (page.tsx).
 * Its visibility is fully derived from `/api/setup/status` — a tiny
 * Server-Route that consolidates engine + github + push status into a
 * single JSON. We re-validate on focus to react to the user finishing
 * a setup in another tab.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface SetupStatus {
  engines: { ready: number; total: number };
  github: { connected: boolean };
  push: { vapidConfigured: boolean; subscribed?: boolean };
  onboardingCompleted: boolean;
}

interface SetupHeroProps {
  /** If true, do not render even if setup is incomplete. */
  hidden?: boolean;
}

const CACHE_KEY = 'lazyos.setup.hero.dismissedUntil';
const SHOW_GITHUB_KEY = 'lazyos.setup.show-github';

export function SetupHero({ hidden }: SetupHeroProps = {}): React.JSX.Element | null {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showGithubCard, setShowGithubCard] = useState(false);

  // Read cached dismissal-until on mount + opt-in flag for GitHub-card.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw && Number(raw) > Date.now()) setDismissed(true);
    } catch {
      /* ignore */
    }
    try {
      if (localStorage.getItem(SHOW_GITHUB_KEY) === '1') {
        setShowGithubCard(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/status', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as SetupStatus;
      setStatus(data);
    } catch {
      /* offline / not-yet-mounted */
    }
  }, []);

  useEffect(() => {
    void load();
    const onFocus = (): void => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(CACHE_KEY, String(Date.now() + 60 * 60 * 1000));
    } catch {
      /* ignore */
    }
  }, []);

  if (hidden || dismissed || !status) return null;

  const enginesReady = status.engines.ready > 0;
  const githubReady = status.github.connected;
  // Directive 2026-05-23 ("shows three steps although push is enabled"):
  // push counts as ready if EITHER the server knows a subscription
  // OR VAPID is disabled server-side (= feature off). That way
  // the card disappears as soon as the user enables push.
  const pushReady = !!status.push.subscribed || status.push.vapidConfigured === false;

  // GitHub-optional directive 2026-05-23: GitHub is NEVER required for the
  // hero to disappear. Only engines + push count for the gating decision.
  // The GitHub-card is rendered ONLY if the user opted-in (and not
  // already connected) — purely informational, never gating.
  const renderGithubCard = showGithubCard && !githubReady;

  // Directive 2026-05-23 (bug report #3): onboardingCompleted is NO
  // longer part of the gate — the setup hero disappears as soon as the two
  // concretely visible cards (engine + push) are green. Otherwise the
  // hero shows "three steps" although all three visible steps are done
  // and a hidden onboarding flag has not yet been set.
  if (enginesReady && pushReady && !renderGithubCard) {
    return null;
  }

  return (
    <section
      className="setup-hero"
      data-testid="setup-hero"
      aria-labelledby="setup-hero-title"
      style={{
        maxWidth: 1100,
        margin: '0 auto 32px',
        padding: 'clamp(20px, 3vw, 32px)',
        border: '0.5px solid var(--line-2)',
        borderRadius: 16,
        background: 'var(--card)',
        position: 'relative',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div>
          <p
            className="t-kicker"
            style={{
              color: 'var(--a-now)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              marginBottom: 8,
            }}
          >
            Setup
          </p>
          <h2
            id="setup-hero-title"
            style={{
              fontSize: 'clamp(20px, 2.5vw, 26px)',
              fontWeight: 500,
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
              color: 'var(--ink)',
              margin: 0,
            }}
          >
            {(() => {
              // Directive 2026-05-23: headline reflects what's actually
              // missing — never "drei Schritte" when only one step is open.
              // Cards-count counts the rendered cards (engine + push
              // always; github only on opt-in).
              const cardsRendered = 2 + (renderGithubCard ? 1 : 0);
              const missing =
                (enginesReady ? 0 : 1) +
                (pushReady ? 0 : 1) +
                (renderGithubCard ? 1 : 0);
              if (missing === 0) return 'Setup abgeschlossen.';
              if (missing === 1) return 'Ein Schritt, dann läuft alles.';
              if (missing === 2) return 'Zwei Schritte, dann läuft alles.';
              return `${cardsRendered === 3 ? 'Drei' : 'Zwei'} Schritte, dann läuft alles.`;
            })()}
          </h2>
          {/*
            Directive 2026-05-23: show the onboarding-resume banner only when
            BOTH hold: (a) onboarding not completed AND (b)
            at least one card still open. When the user is functionally
            done (engine + push green), onboarding implicitly counts as
            done — no longer show "resume".
          */}
          {!status.onboardingCompleted && !(enginesReady && pushReady) && (
            <p
              style={{
                fontSize: 13,
                color: 'var(--ink-2)',
                marginTop: 8,
                lineHeight: 1.5,
                maxWidth: 540,
              }}
            >
              Du hast das Onboarding noch nicht abgeschlossen.
              {' '}
              <Link
                href="/oss-onboarding"
                data-testid="setup-hero-resume-onboarding"
                style={{
                  color: 'var(--a-now)',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                }}
              >
                Onboarding fortsetzen
              </Link>
              .
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Setup-Hinweis ausblenden"
          data-testid="setup-hero-dismiss"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--ink-3)',
            fontSize: 18,
            cursor: 'pointer',
            padding: 4,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 12,
        }}
      >
        <SetupCard
          id="engine"
          title="Engine wählen"
          desc={
            enginesReady
              ? `${status.engines.ready} von ${status.engines.total} verfügbar.`
              : 'Noch keine LLM-Engine erreichbar. Wähle claude-cli, codex oder ollama.'
          }
          ready={enginesReady}
          href="/settings#engines"
          testId="setup-card-engines"
        />
        {renderGithubCard ? (
          <SetupCard
            id="github"
            title="GitHub verbinden (optional)"
            desc="lazyOS läuft auch ohne GitHub. Verbinde nur, wenn du Repo-gebundene Workspaces willst."
            ready={githubReady}
            href="/settings#github"
            testId="setup-card-github"
          />
        ) : null}
        <SetupCard
          id="push"
          title="Push aktivieren"
          desc={
            status.push.vapidConfigured === false
              ? 'Push ist serverseitig deaktiviert (VAPID fehlt).'
              : status.push.subscribed
                ? 'Push ist aktiv. Du erhältst Notifications für P0-Tickets.'
                : 'Aktiviere Push, um Tickets, Approvals und Worker-Errors live zu sehen.'
          }
          ready={pushReady}
          href="/settings#push"
          testId="setup-card-push"
        />
      </div>
    </section>
  );
}

function SetupCard({
  id,
  title,
  desc,
  ready,
  href,
  testId,
}: {
  id: string;
  title: string;
  desc: string;
  ready: boolean;
  href: string;
  testId: string;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      data-testid={testId}
      data-ready={ready ? 'yes' : 'no'}
      style={{
        display: 'block',
        padding: 16,
        background: ready ? 'var(--card-2)' : 'var(--card)',
        border: ready
          ? '0.5px solid color-mix(in oklab, var(--a-now) 30%, var(--line-2))'
          : '0.5px solid var(--line-2)',
        borderRadius: 12,
        textDecoration: 'none',
        color: 'var(--ink)',
        transition: 'background 240ms cubic-bezier(0.4, 0, 0.2, 1), border-color 240ms ease',
        position: 'relative',
        minHeight: 130,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: ready ? 'var(--a-now)' : 'var(--ink-3)',
            boxShadow: ready ? '0 0 8px var(--a-now)' : 'none',
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: ready ? 'var(--a-now)' : 'var(--ink-3)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          {ready ? 'Bereit' : 'Setup'}
        </span>
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 500,
          color: 'var(--ink)',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <p
        style={{
          fontSize: 12,
          color: 'var(--ink-2)',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        {desc}
      </p>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          bottom: 12,
          right: 14,
          fontSize: 12,
          color: ready ? 'var(--ink-2)' : 'var(--a-now)',
        }}
      >
        →
      </span>
    </Link>
  );
}

export default SetupHero;
