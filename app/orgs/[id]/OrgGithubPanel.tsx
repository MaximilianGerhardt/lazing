"use client";

/**
 * OrgGithubPanel — GitHub connection at the org level (Slice D).
 *
 * States:
 *   loading   — status request to GET /api/orgs/[id]/github is running.
 *   idle      — not connected. PAT form (only visible to admins).
 *   connected — login + avatar + repo list + disconnect button.
 *   error     — status request failed.
 *
 * Security requirement (mirrors API conventions):
 *   - Token field of type "password", cleared immediately after a successful
 *     submit. The token never appears in the state after the submit.
 *   - Disconnect adds a window.confirm barrier.
 *   - Only admins/founder see the PAT form and the disconnect button.
 *
 * Design: settings-hub-* classes (components.css), no new hex values,
 * only var(--…) tokens. One primary button per state (Jobs/Rams discipline).
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useToast } from "@/lib/ui/tst/useToast";

// ─── API shape types (exactly like the route responses) ──────────────────────

interface StatusResponse {
  connected: boolean;
  githubLogin?: string | null;
  lastValidatedAt?: number | null;
}

interface ConnectResponse {
  githubLogin?: string;
  avatarUrl?: string | null;
  error?: string;
  message?: string;
}

interface Repo {
  name: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  url: string;
}

interface ReposResponse {
  repos?: Repo[];
  error?: string;
  message?: string;
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface Props {
  orgId: string;
  isAdmin: boolean;
}

// ─── Status pill (mirrors GithubSettingsClient) ────────────────────────────

type PillStatus = "ready" | "setup" | "off";

function StatusPill({ status, text }: { status: PillStatus; text: string }): React.JSX.Element {
  return (
    <span className={`settings-hub-pill settings-hub-pill--${status}`}>
      <span className="settings-hub-pill-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

// ─── Repo row ─────────────────────────────────────────────────────────────

function RepoRow({ repo }: { repo: Repo }): React.JSX.Element {
  return (
    <li
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        background: "var(--card-2)",
        borderTop: "0.5px solid var(--line)",
        fontSize: 13,
      }}
    >
      <div style={{ flex: 1, minWidth: 180 }}>
        <a
          href={repo.url}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: "var(--ink)", textDecoration: "none", fontWeight: 500 }}
          onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
          onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
        >
          {repo.fullName}
        </a>
        {repo.isPrivate && (
          <span style={privateBadgeStyle}>Private</span>
        )}
      </div>
      <span style={branchStyle}>{repo.defaultBranch}</span>
    </li>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function OrgGithubPanel({ orgId, isAdmin }: Props): React.JSX.Element {
  const toast = useToast();

  // — Status loading phase —
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // — Connection state —
  const [connected, setConnected] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);

  // — PAT form —
  const [patValue, setPatValue] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // — Repos —
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  // — Disconnect —
  const [disconnecting, setDisconnecting] = useState(false);

  // Prevents a duplicate status fetch in StrictMode.
  const didFetch = useRef(false);

  // ── Load status ────────────────────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/github`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setStatusError(`Status konnte nicht geladen werden (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as StatusResponse;
      setConnected(data.connected);
      setGithubLogin(data.githubLogin ?? null);
    } catch {
      setStatusError("Netzwerkfehler beim Laden des GitHub-Status.");
    } finally {
      setStatusLoading(false);
    }
  }, [orgId]);

  // ── Load repos ─────────────────────────────────────────────────────────
  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    setReposError(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/github/repos`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as ReposResponse;
        setReposError(data.message ?? data.error ?? `HTTP ${res.status}`);
        setRepos([]);
        return;
      }
      const data = (await res.json()) as ReposResponse;
      setRepos(data.repos ?? []);
    } catch {
      setReposError("Netzwerkfehler beim Laden der Repositories.");
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  }, [orgId]);

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;
    void loadStatus();
  }, [loadStatus]);

  // ── Load repos after connect/status load ────────────────────────────────
  useEffect(() => {
    if (connected && !statusLoading) {
      void loadRepos();
    }
  }, [connected, statusLoading, loadRepos]);

  // ── Connect PAT ────────────────────────────────────────────────────────
  const submitPat = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const token = patValue.trim();
      if (!token) return;
      setConnecting(true);
      setConnectError(null);
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/github/connect`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // The token leaves the browser only in this request.
            body: JSON.stringify({ token }),
          },
        );
        // Remove the token from the state immediately — regardless of the result.
        setPatValue("");
        const data = (await res.json()) as ConnectResponse;
        if (!res.ok) {
          setConnectError(data.message ?? data.error ?? `HTTP ${res.status}`);
          return;
        }
        setConnected(true);
        setGithubLogin(data.githubLogin ?? null);
      } catch {
        setPatValue("");
        setConnectError("Netzwerkfehler beim Verbinden.");
      } finally {
        setConnecting(false);
      }
    },
    [orgId, patValue],
  );

  // ── Disconnect ───────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (
      !window.confirm(
        "GitHub-Verbindung der Organisation trennen? Vorhandene Workspace-Bindings bleiben bestehen.",
      )
    )
      return;
    setDisconnecting(true);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/github`,
        { method: "DELETE" },
      );
      if (res.ok) {
        setConnected(false);
        setGithubLogin(null);
        setRepos(null);
        toast.ok("GitHub getrennt", "Workspace-Bindings bleiben erhalten.");
      } else {
        toast.err("Trennen fehlgeschlagen", `HTTP ${res.status}`);
      }
    } catch (err) {
      toast.err("Trennen fehlgeschlagen", err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  }, [orgId, toast]);

  // ─── Loading skeleton ────────────────────────────────────────────────────────
  if (statusLoading) {
    return (
      <section className="settings-hub-card" aria-label="GitHub-Verbindung laden">
        <header className="settings-hub-card-head">
          <div className="settings-hub-card-head-text">
            <h2 className="settings-hub-card-title">GitHub</h2>
          </div>
          <StatusPill status="off" text="Laden…" />
        </header>
      </section>
    );
  }

  // ─── Error while loading ────────────────────────────────────────────────────
  if (statusError) {
    return (
      <section className="settings-hub-card" aria-label="GitHub-Status-Fehler">
        <header className="settings-hub-card-head">
          <div className="settings-hub-card-head-text">
            <h2 className="settings-hub-card-title">GitHub</h2>
          </div>
          <StatusPill status="off" text="Fehler" />
        </header>
        <div className="settings-hub-card-body">
          <p className="settings-hub-error">{statusError}</p>
          <div className="settings-hub-actions">
            <button
              type="button"
              className="settings-hub-btn settings-hub-btn--ghost"
              onClick={() => { didFetch.current = false; void loadStatus(); }}
            >
              Erneut versuchen
            </button>
          </div>
        </div>
      </section>
    );
  }

  // ─── Not connected ──────────────────────────────────────────────────────
  if (!connected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <section
          className="settings-hub-card"
          aria-labelledby="org-github-connect-title"
        >
          <header className="settings-hub-card-head">
            <div className="settings-hub-card-head-text">
              <h2
                id="org-github-connect-title"
                className="settings-hub-card-title"
              >
                GitHub
              </h2>
              <p className="settings-hub-card-desc">
                Verbinde ein GitHub-Konto mit dieser Organisation, um
                Repositories organisationsweit bereitzustellen.
              </p>
            </div>
            <StatusPill status="setup" text="Nicht verbunden" />
          </header>

          <div className="settings-hub-card-body">
            <p style={infoStyle}>
              Diese GitHub-Verbindung gilt für die gesamte Organisation. Nur
              Org-Admins können sie verbinden oder trennen.
            </p>

            {isAdmin ? (
              <form
                onSubmit={submitPat}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                  marginTop: 16,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  <label
                    htmlFor="org-pat-input"
                    style={labelStyle}
                  >
                    Personal Access Token
                  </label>
                  <input
                    id="org-pat-input"
                    type="password"
                    autoComplete="off"
                    value={patValue}
                    onChange={(e) => setPatValue(e.target.value)}
                    placeholder="ghp_… oder github_pat_…"
                    required
                    disabled={connecting}
                    style={patInputStyle}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor =
                        "color-mix(in oklab, var(--a-now, var(--primary)) 50%, var(--line-2))";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = "var(--line-2)";
                    }}
                  />
                </div>

                <p style={hintStyle}>
                  Token erstellen unter{" "}
                  <a
                    href="https://github.com/settings/tokens/new?scopes=repo,read:user,user:email&description=lazing-org"
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ textDecoration: "underline", color: "inherit" }}
                  >
                    github.com/settings/tokens
                  </a>{" "}
                  — Scopes:{" "}
                  <code className="settings-hub-code">repo</code>,{" "}
                  <code className="settings-hub-code">read:user</code>,{" "}
                  <code className="settings-hub-code">user:email</code>.
                </p>

                {connectError && (
                  <p className="settings-hub-error">{connectError}</p>
                )}

                <div className="settings-hub-actions">
                  <button
                    type="submit"
                    disabled={connecting || !patValue.trim()}
                    className="settings-hub-btn settings-hub-btn--primary"
                  >
                    {connecting ? "Verbinde…" : "Mit PAT verbinden"}
                  </button>
                </div>
              </form>
            ) : (
              <p className="settings-hub-muted" style={{ marginTop: 16 }}>
                Nur Org-Admins können GitHub verbinden.
              </p>
            )}
          </div>
        </section>
      </div>
    );
  }

  // ─── Connected ────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Connection card */}
      <section
        className="settings-hub-card"
        aria-labelledby="org-github-connected-title"
      >
        <header className="settings-hub-card-head">
          <div className="settings-hub-card-head-text">
            <h2
              id="org-github-connected-title"
              className="settings-hub-card-title"
            >
              {githubLogin ? `@${githubLogin}` : "GitHub"}
            </h2>
            <p className="settings-hub-card-desc">
              via Personal Access Token
            </p>
          </div>
          <StatusPill status="ready" text="Verbunden" />
        </header>

        <div className="settings-hub-card-body">
          <p style={infoStyle}>
            Diese GitHub-Verbindung gilt für die gesamte Organisation. Nur
            Org-Admins können sie verbinden oder trennen.
          </p>

          {isAdmin && (
            <div className="settings-hub-actions" style={{ marginTop: 14 }}>
              <button
                type="button"
                onClick={() => void disconnect()}
                disabled={disconnecting}
                className="settings-hub-btn settings-hub-btn--ghost"
                style={{ color: "var(--ink-2)" }}
              >
                {disconnecting ? "Trenne…" : "Verbindung trennen"}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Repo list */}
      <section
        className="settings-hub-card"
        aria-labelledby="org-github-repos-title"
      >
        <header className="settings-hub-card-head">
          <div className="settings-hub-card-head-text">
            <h2
              id="org-github-repos-title"
              className="settings-hub-card-title"
            >
              Repositories
            </h2>
            <p className="settings-hub-card-desc">
              Alle über diese Org-Verbindung erreichbaren Repositories.
              Workspace-Zuordnung erfolgt in Slice C.
            </p>
          </div>
          {repos && repos.length > 0 && (
            <StatusPill status="ready" text={`${repos.length} verfügbar`} />
          )}
        </header>

        <div className="settings-hub-card-body">
          {reposLoading && (
            <p className="settings-hub-muted">Repositories werden geladen…</p>
          )}

          {reposError && !reposLoading && (
            <p className="settings-hub-error">{reposError}</p>
          )}

          {!reposLoading && !reposError && repos && repos.length === 0 && (
            <p className="settings-hub-muted">
              Keine Repositories gefunden.
            </p>
          )}

          {!reposLoading && repos && repos.length > 0 && (
            <ul
              role="list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 1,
                borderRadius: 10,
                overflow: "hidden",
                border: "0.5px solid var(--line)",
                background: "var(--card-2)",
              }}
            >
              {repos.map((repo) => (
                <RepoRow key={repo.fullName} repo={repo} />
              ))}
            </ul>
          )}

          {!reposLoading && (
            <div className="settings-hub-actions" style={{ marginTop: 14 }}>
              <button
                type="button"
                onClick={() => void loadRepos()}
                disabled={reposLoading}
                className="settings-hub-btn settings-hub-btn--ghost"
              >
                Aktualisieren
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const infoStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: "var(--ink-3)",
};

const labelStyle: CSSProperties = {
  fontSize: "var(--fs-label)",  /* 11px form-label — uppercase+spacing OK */
  color: "var(--ink-3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

const patInputStyle: CSSProperties = {
  width: "100%",
  height: 36,
  padding: "0 12px",
  borderRadius: 10,
  border: "0.5px solid var(--line-2)",
  background: "var(--card-3)",
  color: "var(--ink)",
  fontSize: 13,
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  outline: "none",
  transition: "border-color 240ms cubic-bezier(0.16, 1, 0.3, 1)",
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--fs-body)",
  color: "var(--ink-3)",
  lineHeight: "var(--lh-body)",
};

const privateBadgeStyle: CSSProperties = {
  marginLeft: 8,
  padding: "2px 6px",
  borderRadius: 4,
  background: "color-mix(in oklab, var(--a-now) 18%, transparent)",
  color: "var(--ink-2)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const branchStyle: CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  fontSize: 11,
  color: "var(--ink-3)",
  flexShrink: 0,
};
