"use client";

/**
 * GithubSettingsClient — Apple-minimal redesign (Jobs/Rams discipline).
 *
 * State machine:
 *   - "idle"        → Not connected. Primary OAuth CTA + collapsible PAT
 *                     fallback. Status pill: "Nicht verbunden" (setup-amber).
 *   - "connecting"  → POST /api/github/connect in flight.
 *   - "connected"   → Avatar + login + auth-kind + Disconnect.
 *                     Repos list with workspace-binding picker.
 *                     Status pill: "@login" (ready-green).
 *
 * All visuals via `settings-hub-*` classes (Pitch-Black, 0.5px hairlines,
 * 240ms cubic-bezier, SF-Pro stack). One primary action per state.
 */

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/lib/ui/tst/useToast";

interface Workspace {
  id: string;
  label: string;
}

interface Repo {
  id: number;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  isArchived: boolean;
}

interface Binding {
  id: string;
  workspaceId: string;
  repoFullName: string;
}

interface Props {
  initialConnected: boolean;
  initialLogin: string | null;
  initialAvatarUrl: string | null;
  initialAuthKind: "pat" | "oauth" | null;
  oauthAvailable: boolean;
}

// ─── Local status pill (mirrors SettingsHubClient.StatusPill) ───────────

type StatusKind = "ready" | "setup" | "off";

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
      data-testid={`github-status-pill-${status}`}
    >
      <span className="settings-hub-pill-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

// ─── Main component ─────────────────────────────────────────────────────

export default function GithubSettingsClient({
  initialConnected,
  initialLogin,
  initialAvatarUrl,
  initialAuthKind,
  oauthAvailable,
}: Props): React.JSX.Element {
  const toast = useToast();
  const [connected, setConnected] = useState(initialConnected);
  const [login, setLogin] = useState(initialLogin);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [authKind, setAuthKind] = useState<"pat" | "oauth" | null>(initialAuthKind);

  const [showPatForm, setShowPatForm] = useState(!oauthAvailable);
  const [patValue, setPatValue] = useState("");
  const [connectingPat, setConnectingPat] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [linkState, setLinkState] = useState<
    Record<string, "idle" | "pending" | "done">
  >({});

  const refreshRepos = useCallback(async () => {
    setReposLoading(true);
    setReposError(null);
    try {
      const res = await fetch("/api/github/repos", { cache: "no-store" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setReposError(data.message ?? data.error ?? `HTTP ${res.status}`);
        setRepos([]);
        return;
      }
      const data = (await res.json()) as { repos: Repo[] };
      setRepos(data.repos);
    } catch (err) {
      setReposError(err instanceof Error ? err.message : "unknown");
      setRepos([]);
    } finally {
      setReposLoading(false);
    }
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const res = await fetch("/api/workspaces", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        workspaces: Array<{ id: string; label: string }>;
      };
      setWorkspaces(data.workspaces.map((w) => ({ id: w.id, label: w.label })));
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    if (connected) {
      refreshRepos();
      refreshWorkspaces();
    }
  }, [connected, refreshRepos, refreshWorkspaces]);

  const submitPat = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const token = patValue.trim();
      if (!token) return;
      setConnectingPat(true);
      setConnectError(null);
      try {
        const res = await fetch("/api/github/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json()) as {
          connected?: boolean;
          login?: string;
          avatarUrl?: string;
          authKind?: "pat" | "oauth";
          error?: string;
          message?: string;
          hint?: string;
        };
        if (!res.ok || !data.connected) {
          const msg = data.message ?? data.hint ?? data.error ?? `HTTP ${res.status}`;
          setConnectError(msg);
          toast.err("Verbindung fehlgeschlagen", msg);
          return;
        }
        setConnected(true);
        setLogin(data.login ?? null);
        setAvatarUrl(data.avatarUrl ?? null);
        setAuthKind(data.authKind ?? "pat");
        setPatValue("");
        toast.ok("GitHub verbunden", data.login ? `@${data.login}` : undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        setConnectError(msg);
        toast.err("Verbindung fehlgeschlagen", msg);
      } finally {
        setConnectingPat(false);
      }
    },
    [patValue],
  );

  const disconnect = useCallback(async () => {
    if (!confirm("GitHub-Verbindung trennen? Repo-Bindings bleiben erhalten."))
      return;
    try {
      const res = await fetch("/api/github/disconnect", { method: "POST" });
      if (res.ok) {
        setConnected(false);
        setLogin(null);
        setAvatarUrl(null);
        setAuthKind(null);
        setRepos(null);
        setBindings([]);
        toast.ok("GitHub getrennt", "Repo-Bindings bleiben erhalten.");
      } else {
        toast.err("Trennen fehlgeschlagen", `HTTP ${res.status}`);
      }
    } catch (err) {
      toast.err("Trennen fehlgeschlagen", err instanceof Error ? err.message : "Netzwerkfehler");
    }
  }, [toast]);

  const linkRepo = useCallback(
    async (workspaceId: string, repoFullName: string) => {
      setLinkState((s) => ({ ...s, [repoFullName]: "pending" }));
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/link-repo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoFullName }),
        });
        if (res.ok) {
          const data = (await res.json()) as { binding: Binding };
          setBindings((prev) => [
            ...prev.filter((b) => b.repoFullName !== repoFullName),
            data.binding,
          ]);
          setLinkState((s) => ({ ...s, [repoFullName]: "done" }));
        } else {
          setLinkState((s) => ({ ...s, [repoFullName]: "idle" }));
        }
      } catch {
        setLinkState((s) => ({ ...s, [repoFullName]: "idle" }));
      }
    },
    [],
  );

  // ─── Not-connected state ──────────────────────────────────────────
  if (!connected) {
    return (
      <section
        className="settings-hub-card"
        data-testid="github-not-connected"
        aria-labelledby="github-connect-title"
      >
        <header className="settings-hub-card-head">
          <div className="settings-hub-card-head-text">
            <h2 id="github-connect-title" className="settings-hub-card-title">
              Verbindung
            </h2>
            <p className="settings-hub-card-desc">
              Wähle OAuth für den Standardweg oder ein Personal Access Token
              für Server-Setups.
            </p>
          </div>
          <StatusPill status="setup" text="Nicht verbunden" />
        </header>

        <div className="settings-hub-card-body">
          {oauthAvailable ? (
            <>
              <div className="settings-hub-actions">
                <a
                  href="/api/auth/github/init"
                  data-testid="github-oauth-button"
                  className="settings-hub-btn settings-hub-btn--primary"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                    style={{ marginRight: 8 }}
                  >
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  Sign in with GitHub
                </a>
                <button
                  type="button"
                  onClick={() => setShowPatForm((s) => !s)}
                  data-testid="github-toggle-pat"
                  className="settings-hub-btn settings-hub-btn--ghost"
                  aria-expanded={showPatForm}
                >
                  {showPatForm ? "PAT-Form ausblenden" : "Personal Access Token nutzen"}
                </button>
              </div>
            </>
          ) : (
            <p className="settings-hub-muted" data-testid="github-oauth-disabled-note">
              OAuth deaktiviert (keine{" "}
              <code className="settings-hub-code">LAZYOS_GITHUB_CLIENT_ID</code>{" "}
              /{" "}
              <code className="settings-hub-code">_SECRET</code>{" "}
              /{" "}
              <code className="settings-hub-code">_CALLBACK</code>{" "}
              gesetzt). Personal Access Token unten verwenden.
            </p>
          )}

          {showPatForm && (
            <form
              onSubmit={submitPat}
              className="settings-hub-kv"
              data-testid="github-pat-form"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                padding: 16,
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label
                  htmlFor="pat-input"
                  style={{
                    fontSize: "var(--fs-label)",  /* 11px form-label — uppercase+spacing OK */
                    color: "var(--ink-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Personal Access Token
                </label>
                <input
                  id="pat-input"
                  data-testid="github-pat-input"
                  type="password"
                  autoComplete="off"
                  value={patValue}
                  onChange={(e) => setPatValue(e.target.value)}
                  placeholder="ghp_… oder github_pat_…"
                  required
                  style={{
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
                    transition:
                      "border-color 240ms cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor =
                      "color-mix(in oklab, var(--a-now, var(--primary)) 50%, var(--line-2))";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = "var(--line-2)";
                  }}
                />
              </div>

              <p
                style={{
                  margin: 0,
                  fontSize: "var(--fs-body)",
                  color: "var(--ink-3)",
                  lineHeight: "var(--lh-body)",
                }}
              >
                Token unter{" "}
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,read:user,user:email&description=lazyos"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="settings-hub-foot-link"
                  style={{ textDecoration: "underline" }}
                >
                  github.com/settings/tokens
                </a>{" "}
                erstellen — Scopes:{" "}
                <code className="settings-hub-code">repo</code>,{" "}
                <code className="settings-hub-code">read:user</code>,{" "}
                <code className="settings-hub-code">user:email</code>.
              </p>

              {connectError && (
                <p
                  data-testid="github-connect-error"
                  className="settings-hub-error"
                >
                  {connectError}
                </p>
              )}

              <div className="settings-hub-actions">
                <button
                  type="submit"
                  disabled={connectingPat || !patValue.trim()}
                  data-testid="github-connect-button"
                  className={`settings-hub-btn ${oauthAvailable ? "settings-hub-btn--ghost" : "settings-hub-btn--primary"}`}
                >
                  {connectingPat ? "Verbinde…" : "Mit PAT verbinden"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    );
  }

  // ─── Connected state ──────────────────────────────────────────────
  return (
    <>
      <section
        className="settings-hub-card"
        data-testid="github-connected"
        aria-labelledby="github-connected-title"
      >
        <header className="settings-hub-card-head">
          <div
            className="settings-hub-card-head-text"
            style={{ display: "flex", alignItems: "center", gap: 14 }}
          >
            {avatarUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={login ?? "GitHub"}
                width={44}
                height={44}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  border: "0.5px solid var(--line-2)",
                  flexShrink: 0,
                }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <h2
                id="github-connected-title"
                className="settings-hub-card-title"
                data-testid="github-connected-login"
                style={{ marginBottom: 2 }}
              >
                @{login ?? "—"}
              </h2>
              <p className="settings-hub-card-desc" style={{ margin: 0 }}>
                via {authKind === "oauth" ? "OAuth" : "Personal Access Token"}
              </p>
            </div>
          </div>
          <StatusPill status="ready" text="Verbunden" />
        </header>

        <div className="settings-hub-card-body">
          <div className="settings-hub-actions">
            <button
              type="button"
              onClick={refreshRepos}
              disabled={reposLoading}
              className="settings-hub-btn settings-hub-btn--ghost"
            >
              {reposLoading ? "Lädt…" : "Repos aktualisieren"}
            </button>
            <button
              type="button"
              onClick={disconnect}
              data-testid="github-disconnect-button"
              className="settings-hub-btn settings-hub-btn--ghost"
              style={{
                color: "var(--ink-2)",
              }}
            >
              Trennen
            </button>
          </div>
        </div>
      </section>

      <section
        className="settings-hub-card"
        data-testid="github-repos-section"
        aria-labelledby="github-repos-title"
        style={{ marginTop: 18 }}
      >
        <header className="settings-hub-card-head">
          <div className="settings-hub-card-head-text">
            <h2 id="github-repos-title" className="settings-hub-card-title">
              Repositories
            </h2>
            <p className="settings-hub-card-desc">
              Verknüpfe ein Repo mit einem Workspace — Scope-isolation bleibt
              je Workspace bestehen.
            </p>
          </div>
          {repos && repos.length > 0 && (
            <StatusPill status="ready" text={`${repos.length} verfügbar`} />
          )}
        </header>

        <div className="settings-hub-card-body">
          {reposError && (
            <p className="settings-hub-error" data-testid="github-repos-error">
              {reposError}
            </p>
          )}

          {repos && repos.length === 0 && !reposLoading && !reposError && (
            <p
              className="settings-hub-muted"
              data-testid="github-repos-empty"
            >
              Keine Repositories gefunden.
            </p>
          )}

          {repos && repos.length > 0 && (
            <ul
              data-testid="github-repos-list"
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
              {repos.map((repo) => {
                const state = linkState[repo.fullName] ?? "idle";
                return (
                  <li
                    key={repo.id}
                    data-testid={`github-repo-${repo.fullName}`}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 14px",
                      background: "var(--card-2)",
                      borderTop: "0.5px solid var(--line)",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <a
                        href={repo.htmlUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{
                          color: "var(--ink)",
                          textDecoration: "none",
                          fontWeight: 500,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.textDecoration = "underline";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.textDecoration = "none";
                        }}
                      >
                        {repo.fullName}
                      </a>
                      {repo.isPrivate && (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "rgba(251, 191, 36, 0.18)",
                            color: "#fbbf24",
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          Private
                        </span>
                      )}
                      {repo.isArchived && (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "rgba(120, 120, 130, 0.18)",
                            color: "var(--ink-3)",
                            fontSize: 10,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          Archived
                        </span>
                      )}
                      {repo.description && (
                        <p
                          style={{
                            margin: "2px 0 0 0",
                            fontSize: 12,
                            color: "var(--ink-3)",
                            lineHeight: 1.4,
                          }}
                        >
                          {repo.description}
                        </p>
                      )}
                    </div>
                    <select
                      defaultValue=""
                      data-testid={`github-link-select-${repo.fullName}`}
                      onChange={(e) => {
                        const wsId = e.target.value;
                        if (wsId) linkRepo(wsId, repo.fullName);
                      }}
                      disabled={state === "pending" || workspaces.length === 0}
                      style={{
                        height: 30,
                        padding: "0 8px",
                        borderRadius: 8,
                        border: "0.5px solid var(--line-2)",
                        background: "var(--card-3)",
                        color: "var(--ink)",
                        fontSize: 12,
                        cursor:
                          state === "pending" || workspaces.length === 0
                            ? "not-allowed"
                            : "pointer",
                      }}
                    >
                      <option value="" disabled>
                        {workspaces.length === 0
                          ? "Keine Workspaces"
                          : "Workspace wählen …"}
                      </option>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                    {state === "pending" && (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--ink-3)",
                        }}
                      >
                        Verbinde…
                      </span>
                    )}
                    {state === "done" && (
                      <span
                        style={{
                          fontSize: 12,
                          color: "#4ade80",
                        }}
                      >
                        Verknüpft
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {bindings.length > 0 && (
            <p
              className="settings-hub-meta"
              data-testid="github-bindings-count"
            >
              {bindings.length} Repo-Workspace-Verknüpfung(en) in dieser Sitzung
              gesetzt.
            </p>
          )}
        </div>
      </section>
    </>
  );
}
