"use client";

/**
 * SettingsHubClient — single-page Settings-Hub with 7 collapsible sections.
 *
 * Apple-minimal Jobs/Rams discipline:
 *   - Pitch-Black background (inherited from .sheet).
 *   - Subtle 0.5px hairlines via `--line-2`.
 *   - One primary CTA per section.
 *   - Brand-gradient only on the active section's primary CTA.
 *   - 240ms cubic-bezier transitions.
 *   - Status-Badge per section: "Bereit" (green) / "Setup" (amber) / "Aus" (zinc).
 *
 * The hub is a stack of <SectionCard/> components. Each card knows its
 * own status + primary-action; the hub itself only wires Section-IDs to
 * anchor-navigation in the side rail.
 *
 * Browser-only state lives here:
 *   - push.state (from usePushSubscription)
 *   - account.signingOut
 *   - engines.refreshing (re-probes /api/system/engines?fresh=1)
 *
 * Server-known state is passed as props (already validated in page.tsx).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { usePushSubscription } from "@/lib/pwa/usePushSubscription";
import { SystemPermissionsCard } from "@/lib/permissions/SystemPermissionsCard";

// ─── Types (mirror page.tsx prop-shape) ─────────────────────────────────

type StatusKind = "ready" | "setup" | "off";

interface EngineProbe {
  engine: "claude-cli" | "codex-cli" | "ollama";
  available: boolean;
  reason: string;
  probeMs?: number;
}

interface EngineSnapshot {
  preferred: string | null;
  detectedAt?: number;
  available: EngineProbe[];
}

interface Props {
  userId: string;
  github: {
    connected: boolean;
    login: string | null;
    authKind: "pat" | "oauth" | null;
    oauthAvailable: boolean;
  };
  engines: EngineSnapshot | null;
  email: {
    provider: string;
    resendKeyPresent: boolean;
  };
  push: {
    vapidPublicKey: string;
  };
  advanced: {
    nodeEnv: string;
    dbPath: string;
    pushSecretSet: boolean;
    brandName: string;
  };
}

interface SectionMeta {
  id: string;
  label: string;
  status: StatusKind;
  statusText: string;
}

// ─── Status pill (single source of truth for color logic) ───────────────

function StatusPill({
  status,
  text,
}: {
  status: StatusKind;
  text: string;
}): React.JSX.Element {
  return (
    <span
      className={`settings-hub-pill settings-hub-pill--${status}`}
      data-testid={`settings-hub-pill-${status}`}
    >
      <span className="settings-hub-pill-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

// ─── Section card primitive ─────────────────────────────────────────────

function SectionCard({
  id,
  title,
  description,
  status,
  statusText,
  children,
}: {
  id: string;
  title: string;
  description: string;
  status: StatusKind;
  statusText: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      id={id}
      data-testid={`settings-section-${id}`}
      className="settings-hub-card"
      aria-labelledby={`${id}-title`}
    >
      <header className="settings-hub-card-head">
        <div className="settings-hub-card-head-text">
          <h2 id={`${id}-title`} className="settings-hub-card-title">
            {title}
          </h2>
          <p className="settings-hub-card-desc">{description}</p>
        </div>
        <StatusPill status={status} text={statusText} />
      </header>
      <div className="settings-hub-card-body">{children}</div>
    </section>
  );
}

// ─── Main hub component ─────────────────────────────────────────────────

export default function SettingsHubClient({
  userId,
  github,
  engines,
  email,
  push,
  advanced,
}: Props): React.JSX.Element {
  // ─── Account section state ───────────────────────────────────────
  const [signingOut, setSigningOut] = useState(false);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      window.location.assign("/login");
    } catch {
      setSigningOut(false);
    }
  }, []);

  // ─── Engines section state ───────────────────────────────────────
  const [engineSnapshot, setEngineSnapshot] = useState<EngineSnapshot | null>(engines);
  const [refreshingEngines, setRefreshingEngines] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  const refreshEngines = useCallback(async () => {
    setRefreshingEngines(true);
    setEngineError(null);
    try {
      const res = await fetch("/api/system/engines?fresh=1", { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        setEngineError(data.message ?? data.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as EngineSnapshot;
      setEngineSnapshot(data);
    } catch (err) {
      setEngineError(err instanceof Error ? err.message : "unknown");
    } finally {
      setRefreshingEngines(false);
    }
  }, []);

  // ─── Push section state (browser only) ───────────────────────────
  const sub = usePushSubscription({ vapidPublicKey: push.vapidPublicKey });
  const [sendingTest, setSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const togglePush = useCallback(async () => {
    if (sub.state === "subscribed") {
      await sub.unsubscribe();
    } else if (sub.state === "idle" || sub.state === "error") {
      await sub.subscribe();
    }
  }, [sub]);

  const sendTestPush = useCallback(async () => {
    setSendingTest(true);
    setTestResult(null);
    try {
      // /api/push/test is session-authed (cookie). The Bearer-only
      // /api/push/send route is reserved for Server-to-Server calls.
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "laz.ing Test-Push",
          body: "Wenn du das siehst, läuft Push.",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sent?: number;
        error?: string;
        hint?: string;
      };
      if (res.ok && data.ok) {
        setTestResult(`Gesendet: ${data.sent ?? 0}`);
      } else if (res.status === 401) {
        setTestResult("401 — Session abgelaufen. Bitte neu anmelden.");
      } else if (res.status === 503) {
        setTestResult(data.hint ?? "Server nicht konfiguriert.");
      } else {
        setTestResult(`Fehler ${res.status}${data.error ? ` — ${data.error}` : ""}`);
      }
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "send failed");
    } finally {
      setSendingTest(false);
    }
  }, []);

  // ─── Status computations ─────────────────────────────────────────
  const sections: SectionMeta[] = useMemo(() => {
    const acc: SectionMeta = {
      id: "account",
      label: "Account",
      status: "ready",
      statusText: `User ${userId.slice(0, 8)}…`,
    };

    const enginesReady = engineSnapshot?.available.filter((e) => e.available).length ?? 0;
    const eng: SectionMeta = {
      id: "engines",
      label: "Engines",
      status: enginesReady > 0 ? "ready" : "setup",
      statusText: `${enginesReady} / 3 verfügbar`,
    };

    // GitHub-optional direktive 2026-05-23: GitHub ist NIE im "setup"-State
    // (= amber/required Signal). Nicht-verbunden = neutraler "off"-Pill mit
    // Text "Optional", damit User nie das Gefühl haben sie MÜSSEN GitHub
    // verbinden.
    const gh: SectionMeta = {
      id: "github",
      label: "GitHub",
      status: github.connected ? "ready" : "off",
      statusText: github.connected ? `@${github.login ?? "—"}` : "Optional",
    };

    const pushStatus: StatusKind =
      sub.state === "subscribed"
        ? "ready"
        : sub.state === "unsupported" || sub.state === "denied" || !push.vapidPublicKey
          ? "off"
          : "setup";
    const pushText =
      sub.state === "subscribed"
        ? "Aktiv"
        : !push.vapidPublicKey
          ? "VAPID fehlt"
          : sub.state === "denied"
            ? "Browser-Block"
            : sub.state === "unsupported"
              ? "Nicht unterstützt"
              : "Nicht abonniert";
    const pushSection: SectionMeta = {
      id: "push",
      label: "Push",
      status: pushStatus,
      statusText: pushText,
    };

    const emailReady = email.provider === "resend" && email.resendKeyPresent;
    const em: SectionMeta = {
      id: "email",
      label: "Email",
      status: emailReady ? "ready" : email.provider === "console" ? "setup" : "off",
      statusText:
        email.provider === "console"
          ? "Console (Dev)"
          : email.provider === "resend"
            ? email.resendKeyPresent
              ? "Resend"
              : "Resend — Key fehlt"
            : email.provider,
    };

    const ws: SectionMeta = {
      id: "workspace",
      label: "Workspace",
      status: "ready",
      statusText: "Wechseln via TopNav",
    };

    const adv: SectionMeta = {
      id: "advanced",
      label: "Erweitert",
      status: "ready",
      statusText: advanced.nodeEnv,
    };

    const design: SectionMeta = {
      id: "design",
      label: "Design-Bibliothek",
      status: "ready",
      statusText: "16 Komponenten",
    };

    return [acc, eng, gh, pushSection, em, ws, adv, design];
  }, [userId, engineSnapshot, github, sub.state, push.vapidPublicKey, email, advanced]);

  // ─── Sidebar nav (sticky anchor list) ────────────────────────────
  const [activeId, setActiveId] = useState<string>("account");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onScroll = (): void => {
      const ids = sections.map((s) => s.id);
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.top > 80 && r.top < 260) {
          setActiveId(id);
          return;
        }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [sections]);

  // ─── Render ──────────────────────────────────────────────────────
  return (
    <div className="settings-hub-grid">
      {/* SIDEBAR */}
      <aside className="settings-hub-rail" aria-label="Settings-Navigation">
        <ul className="settings-hub-rail-list" role="list">
          {sections.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className={`settings-hub-rail-link${activeId === s.id ? " is-active" : ""}`}
                data-testid={`settings-rail-${s.id}`}
                aria-current={activeId === s.id ? "true" : undefined}
              >
                <span className="settings-hub-rail-label">{s.label}</span>
                <StatusPill status={s.status} text={s.statusText} />
              </a>
            </li>
          ))}
        </ul>
      </aside>

      {/* SECTIONS */}
      <div className="settings-hub-stack">
        {/* 1. ACCOUNT */}
        <SectionCard
          id="account"
          title="Account"
          description="Deine Identität in diesem laz.ing-Workspace."
          status={sections[0].status}
          statusText={sections[0].statusText}
        >
          <dl className="settings-hub-kv">
            <div>
              <dt>User-ID</dt>
              <dd>
                <code className="settings-hub-code">{userId}</code>
              </dd>
            </div>
          </dl>
          <div className="settings-hub-actions">
            <Link
              href="/oss-onboarding"
              data-testid="settings-account-restart-onboarding"
              className="settings-hub-btn settings-hub-btn--primary"
            >
              Onboarding neu starten
            </Link>
            <button
              type="button"
              onClick={signOut}
              disabled={signingOut}
              data-testid="settings-account-signout"
              className="settings-hub-btn settings-hub-btn--ghost"
            >
              {signingOut ? "Melde ab …" : "Abmelden"}
            </button>
          </div>
        </SectionCard>

        {/* System-Berechtigungen — Permission-Broker (OSS fragt Rechte selbst an) */}
        <SystemPermissionsCard />

        {/* 2. ENGINES */}
        <SectionCard
          id="engines"
          title="Engines"
          description="Welche LLM-Engines erreichbar sind — claude-cli, codex, ollama."
          status={sections[1].status}
          statusText={sections[1].statusText}
        >
          {engineError && (
            <p className="settings-hub-error" data-testid="settings-engines-error">
              {engineError}
            </p>
          )}
          {engineSnapshot ? (
            <ul className="settings-hub-engine-list" role="list">
              {engineSnapshot.available.map((e) => (
                <li
                  key={e.engine}
                  data-testid={`settings-engine-${e.engine}`}
                  className={`settings-hub-engine-row${
                    engineSnapshot.preferred === e.engine ? " is-preferred" : ""
                  }`}
                >
                  <div className="settings-hub-engine-meta">
                    <span className="settings-hub-engine-name">{e.engine}</span>
                    {engineSnapshot.preferred === e.engine && (
                      <span className="settings-hub-engine-tag">Standard</span>
                    )}
                    <span className="settings-hub-engine-reason">{e.reason}</span>
                  </div>
                  <StatusPill
                    status={e.available ? "ready" : "off"}
                    text={
                      e.available
                        ? typeof e.probeMs === "number"
                          ? `${e.probeMs} ms`
                          : "ok"
                        : "unavailable"
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-hub-muted">Engine-Status nicht verfügbar.</p>
          )}
          <div className="settings-hub-actions">
            <button
              type="button"
              onClick={refreshEngines}
              disabled={refreshingEngines}
              data-testid="settings-engines-refresh"
              className="settings-hub-btn settings-hub-btn--primary"
            >
              {refreshingEngines ? "Prüfe …" : "Neu prüfen"}
            </button>
          </div>
        </SectionCard>

        {/* 3. GITHUB (optional — lazyOS works fully without it) */}
        <SectionCard
          id="github"
          title="GitHub (Optional)"
          description="lazyOS works fully without GitHub. Connect only for repo-linked workspaces, PR opening, issue read, and branch sync."
          status={sections[2].status}
          statusText={sections[2].statusText}
        >
          {github.connected ? (
            <>
              <dl className="settings-hub-kv">
                <div>
                  <dt>Login</dt>
                  <dd>@{github.login ?? "—"}</dd>
                </div>
                <div>
                  <dt>Auth</dt>
                  <dd>{github.authKind === "oauth" ? "OAuth" : "Personal Access Token"}</dd>
                </div>
              </dl>
              <div className="settings-hub-actions">
                <Link
                  href="/settings/github"
                  className="settings-hub-btn settings-hub-btn--primary"
                  data-testid="settings-github-manage"
                >
                  Repos verwalten
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className="settings-hub-muted">
                <strong>lazyOS works fully without GitHub.</strong> Connect for
                repo-linked workspaces. Tokens werden mit AES-256-GCM
                verschlüsselt gespeichert.
              </p>
              <div className="settings-hub-actions">
                <Link
                  href="/settings/github"
                  className="settings-hub-btn settings-hub-btn--primary"
                  data-testid="settings-github-connect"
                >
                  GitHub verbinden
                </Link>
                {github.oauthAvailable && (
                  <span className="settings-hub-meta">OAuth verfügbar</span>
                )}
              </div>
            </>
          )}
        </SectionCard>

        {/* 4. PUSH */}
        <SectionCard
          id="push"
          title="Push-Benachrichtigungen"
          description="Browser-Push für P0-Tickets, Approvals und Worker-Status."
          status={sections[3].status}
          statusText={sections[3].statusText}
        >
          {!push.vapidPublicKey ? (
            <p className="settings-hub-muted">
              <code className="settings-hub-code">NEXT_PUBLIC_VAPID_PUBLIC_KEY</code> ist
              nicht gesetzt — Push ist Server-seitig deaktiviert.
              Führe{" "}
              <code className="settings-hub-code">node scripts/generate-vapid.mjs</code>{" "}
              aus und starte den Server neu.
            </p>
          ) : sub.state === "unsupported" ? (
            <p className="settings-hub-muted">
              Dieser Browser unterstützt keine Web-Push-Notifications. iOS Safari benötigt
              PWA-Standalone (Share-Sheet → „Zum Home-Bildschirm").
            </p>
          ) : sub.state === "denied" ? (
            <p className="settings-hub-muted">
              Push wurde im Browser blockiert. Öffne System-Settings → Notifications →
              laz.ing und erlaube Benachrichtigungen.
            </p>
          ) : (
            <p className="settings-hub-muted">
              {sub.state === "subscribed"
                ? "Push ist aktiv. Du kannst die Subscription jederzeit beenden."
                : "Aktiviere Push, um Tickets, Approvals und Worker-Errors live zu sehen."}
            </p>
          )}
          <div className="settings-hub-actions">
            <button
              type="button"
              onClick={togglePush}
              disabled={
                !push.vapidPublicKey ||
                sub.state === "unsupported" ||
                sub.state === "denied" ||
                sub.state === "working" ||
                sub.state === "loading"
              }
              data-testid="settings-push-toggle"
              className={`settings-hub-btn ${
                sub.state === "subscribed"
                  ? "settings-hub-btn--ghost"
                  : "settings-hub-btn--primary"
              }`}
            >
              {sub.state === "subscribed"
                ? "Push deaktivieren"
                : sub.state === "working"
                  ? "Schalte um …"
                  : "Push aktivieren"}
            </button>
            {sub.state === "subscribed" && (
              <button
                type="button"
                onClick={sendTestPush}
                disabled={sendingTest}
                data-testid="settings-push-test"
                className="settings-hub-btn settings-hub-btn--ghost"
              >
                {sendingTest ? "Sende …" : "Test-Push senden"}
              </button>
            )}
            {testResult && (
              <span className="settings-hub-meta" data-testid="settings-push-test-result">
                {testResult}
              </span>
            )}
          </div>
        </SectionCard>

        {/* 5. EMAIL */}
        <SectionCard
          id="email"
          title="Email-Versand"
          description="Provider für Magic-Links und Workspace-Invites."
          status={sections[4].status}
          statusText={sections[4].statusText}
        >
          <dl className="settings-hub-kv">
            <div>
              <dt>Provider</dt>
              <dd>
                <code className="settings-hub-code">{email.provider}</code>
              </dd>
            </div>
            <div>
              <dt>Resend-Key</dt>
              <dd>{email.resendKeyPresent ? "gesetzt" : "nicht gesetzt"}</dd>
            </div>
          </dl>
          {email.provider === "console" ? (
            <p className="settings-hub-muted">
              Dev-Modus: Mails landen im Server-Log statt im Postfach.
              Für Produktion setze{" "}
              <code className="settings-hub-code">LAZYOS_EMAIL_PROVIDER=resend</code> und{" "}
              <code className="settings-hub-code">RESEND_API_KEY=re_…</code> in{" "}
              <code className="settings-hub-code">.env.local</code>.
            </p>
          ) : email.provider === "resend" && !email.resendKeyPresent ? (
            <p className="settings-hub-muted">
              Provider ist auf Resend gesetzt, aber{" "}
              <code className="settings-hub-code">RESEND_API_KEY</code> fehlt — alle Sends
              schlagen fehl.
            </p>
          ) : (
            <p className="settings-hub-muted">
              Email-Versand aktiv. EU-Region einstellbar via{" "}
              <code className="settings-hub-code">LAZYOS_RESEND_REGION=eu-west-1</code>.
            </p>
          )}
          <div className="settings-hub-actions">
            <a
              href="https://resend.com/api-keys"
              target="_blank"
              rel="noreferrer noopener"
              className="settings-hub-btn settings-hub-btn--ghost"
              data-testid="settings-email-resend-link"
            >
              Resend öffnen
            </a>
          </div>
        </SectionCard>

        {/* 6. WORKSPACE */}
        <SectionCard
          id="workspace"
          title="Workspace"
          description="Aktiver Workspace und Scope-Einstellungen."
          status={sections[5].status}
          statusText={sections[5].statusText}
        >
          <p className="settings-hub-muted">
            Wechsle den Workspace über den Workspace-Switcher in der TopNav.
            Jeder Workspace hat eigene Repo-Bindings, RAG-Chunks und Audit-Trails
            — Cross-Workspace-Lesen erfordert eine Bridge-Freigabe (DSGVO Art. 30).
          </p>
          <div className="settings-hub-actions">
            <Link
              href="/workstreams?view=kanban"
              className="settings-hub-btn settings-hub-btn--ghost"
              data-testid="settings-workspace-lanes-link"
            >
              Lanes öffnen
            </Link>
          </div>
        </SectionCard>

        {/* 7. ADVANCED */}
        <SectionCard
          id="advanced"
          title="Erweitert"
          description="Database, ENV-Flags und Debug-Informationen."
          status={sections[6].status}
          statusText={sections[6].statusText}
        >
          <dl className="settings-hub-kv">
            <div>
              <dt>NODE_ENV</dt>
              <dd>
                <code className="settings-hub-code">{advanced.nodeEnv}</code>
              </dd>
            </div>
            <div>
              <dt>DB-Pfad</dt>
              <dd>
                <code className="settings-hub-code">{advanced.dbPath}</code>
              </dd>
            </div>
            <div>
              <dt>Push-Secret</dt>
              <dd>{advanced.pushSecretSet ? "gesetzt" : "nicht gesetzt"}</dd>
            </div>
            <div>
              <dt>Brand</dt>
              <dd>
                <code className="settings-hub-code">{advanced.brandName}</code>
              </dd>
            </div>
          </dl>
          <div className="settings-hub-actions">
            <Link
              href="/observatory"
              className="settings-hub-btn settings-hub-btn--ghost"
              data-testid="settings-advanced-observatory"
            >
              Observatory öffnen
            </Link>
            <Link
              href="/reasoning-audit"
              className="settings-hub-btn settings-hub-btn--ghost"
              data-testid="settings-advanced-audit"
            >
              Reasoning-Audit
            </Link>
          </div>
        </SectionCard>

        {/* 8. DESIGN LIBRARY */}
        <SectionCard
          id="design"
          title="Design-Bibliothek"
          description="Visual-Manifest, Tokens und alle 16 Surface-Komponenten."
          status={sections[7].status}
          statusText={sections[7].statusText}
        >
          <p className="settings-hub-muted">
            Die Design-Bibliothek dokumentiert jeden Surface-Baustein und seine
            Tokens — Pitch-Black-Canvas, drei radiale Glows, SF-Pro-Stack.
            Hier landen neue Komponenten zuerst, bevor sie in die App
            wandern.
          </p>
          <div className="settings-hub-actions">
            <Link
              href="/design"
              className="settings-hub-btn settings-hub-btn--primary"
              data-testid="settings-design-open"
            >
              Bibliothek öffnen
            </Link>
            <Link
              href="/how"
              className="settings-hub-btn settings-hub-btn--ghost"
              data-testid="settings-design-how"
            >
              Wie-funktioniert-das
            </Link>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
