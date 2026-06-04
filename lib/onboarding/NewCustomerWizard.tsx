'use client';

/**
 * NewCustomerWizard — guided "new customer" onboarding (Bundle-B · 2026-06-03).
 *
 * One screen per task (Jobs/Rams: one-task-per-screen). Four steps:
 *   1. Customer  → POST /api/orgs            { type: 'client' }   (client org)
 *   2. Workspace → POST /api/workspaces      (org-linked, credentialIsolation
 *                  is derived server-side from type:'client' → 'isolated')
 *   3. GitHub    → POST /api/orgs/[id]/github/connect (PAT, optional)
 *                  + POST /api/workspaces/[id]/link-repo (owner/repo, optional)
 *   4. General   → POST /api/onboarding/general-subchat (idempotent)
 *
 * All endpoints are existing and reused VERBATIM. The final
 * landing mirrors CreateWorkspaceCard exactly: setWorkspaceId(ws, org) seeds
 * localStorage+org context SILENTLY, then router.push(`/?ws=…`) → the founder
 * lands in the scoped main chat of the freshly created customer workspace.
 *
 * Styling: ONLY :root tokens (no new hex), field/label/button shapes taken 1:1
 * from app/orgs/CreateButton.tsx → visually identical to the org modal.
 * Every interactive control ≥44px. Container max 480px, mobile-first.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

import { setWorkspaceId, setOrgIdSilent } from '@/lib/nav/hooks';
import { IconCheck, IconChevronRight } from '@/lib/nav/icons';

type Step = 'kunde' | 'workspace' | 'github' | 'chat' | 'done';

const STEP_ORDER: readonly Step[] = ['kunde', 'workspace', 'github', 'chat'];
const STEP_LABELS: Record<Step, string> = {
  kunde: 'Kunde',
  workspace: 'Workspace',
  github: 'GitHub',
  chat: 'Allgemein',
  done: 'Fertig',
};

interface RepoOption {
  fullName: string;
  isPrivate: boolean;
}

export function NewCustomerWizard(): React.JSX.Element {
  const router = useRouter();

  const [step, setStep] = useState<Step>('kunde');

  // Step 1 — customer (client org)
  const [orgName, setOrgName] = useState('');
  const [orgDescription, setOrgDescription] = useState('');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [createdOrgName, setCreatedOrgName] = useState('');

  // Step 2 — Workspace
  const [workspaceLabel, setWorkspaceLabel] = useState('');
  const [workspaceId, setWorkspaceIdState] = useState<string | null>(null);
  const [workspaceOrgId, setWorkspaceOrgId] = useState<string | null>(null);

  // Step 3 — GitHub (optional)
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [pat, setPat] = useState('');
  const [repoFullName, setRepoFullName] = useState('');
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([]);
  const [reposLoading, setReposLoading] = useState(false);

  // Step 4 — default customer chat
  const [, setGeneralSubchatId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepIndex = STEP_ORDER.indexOf(step);

  /* ----------------------------------------------------------------- */
  /* Step 1 — create the customer (client org).                        */
  /* ----------------------------------------------------------------- */
  const createKunde = useCallback(async (): Promise<void> => {
    const name = orgName.trim();
    if (name.length < 2) {
      setError('Kundenname muss mindestens 2 Zeichen haben.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          type: 'client',
          description: orgDescription.trim() || undefined,
        }),
      });
      if (res.status === 409) {
        setError('Name bereits vergeben — bitte anpassen.');
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(
          (j.message as string) ?? (j.error as string) ?? `HTTP ${res.status}`,
        );
      }
      const j = (await res.json()) as { org: { id: string; name: string } };
      setOrgId(j.org.id);
      setCreatedOrgName(j.org.name);
      // Set the org context SILENTLY (no hard redirect like with useSetOrg), so
      // the following steps run in the new org.
      setOrgIdSilent(j.org.id);
      // Sensibly pre-fill the workspace label.
      setWorkspaceLabel((cur) => (cur.trim().length > 0 ? cur : j.org.name));
      setStep('workspace');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unbekannt');
    } finally {
      setBusy(false);
    }
  }, [orgName, orgDescription]);

  /* ----------------------------------------------------------------- */
  /* Step 2 — first workspace in the customer org.                      */
  /* ----------------------------------------------------------------- */
  const createWorkspace = useCallback(async (): Promise<void> => {
    if (!orgId) return;
    const label = workspaceLabel.trim();
    if (label.length < 2) {
      setError('Workspace-Name muss mindestens 2 Zeichen haben.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, organizationId: orgId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(
          (j.message as string) ?? (j.error as string) ?? `HTTP ${res.status}`,
        );
      }
      const j = (await res.json()) as {
        workspace: { id: string; organizationId: string };
      };
      setWorkspaceIdState(j.workspace.id);
      setWorkspaceOrgId(j.workspace.organizationId);
      setStep('github');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unbekannt');
    } finally {
      setBusy(false);
    }
  }, [orgId, workspaceLabel]);

  /* ----------------------------------------------------------------- */
  /* Step 3 — GitHub: load connection status, optionally connect + repo. */
  /* ----------------------------------------------------------------- */
  // Check the existing org connection as soon as the GitHub step becomes visible.
  useEffect(() => {
    if (step !== 'github' || !orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/github`, {
          cache: 'no-store',
        });
        if (!res.ok) return;
        const j = (await res.json()) as {
          connected?: boolean;
          githubLogin?: string | null;
        };
        if (cancelled) return;
        if (j.connected) {
          setGithubConnected(true);
          setGithubLogin(j.githubLogin ?? null);
        }
      } catch {
        /* non-fatal — the PAT step stays available */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, orgId]);

  // Load the repo pick list as soon as connected.
  useEffect(() => {
    if (step !== 'github' || !orgId || !githubConnected) return;
    let cancelled = false;
    setReposLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/orgs/${encodeURIComponent(orgId)}/github/repos`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const j = (await res.json()) as {
          repos?: Array<{ fullName: string; isPrivate: boolean }>;
        };
        if (cancelled) return;
        if (Array.isArray(j.repos)) {
          setRepoOptions(
            j.repos.map((r) => ({ fullName: r.fullName, isPrivate: r.isPrivate })),
          );
        }
      } catch {
        /* non-fatal — free-text entry stays possible */
      } finally {
        if (!cancelled) setReposLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, orgId, githubConnected]);

  const connectGithub = useCallback(async (): Promise<void> => {
    if (!orgId) return;
    const token = pat.trim();
    if (token.length === 0) {
      setError('Bitte ein GitHub Personal Access Token eingeben.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/github/connect`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        throw new Error(
          (j.message as string) ?? (j.error as string) ?? `HTTP ${res.status}`,
        );
      }
      const j = (await res.json()) as { githubLogin: string };
      setGithubConnected(true);
      setGithubLogin(j.githubLogin);
      setPat(''); // Never keep the token in state (like OrgGithubPanel).
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unbekannt');
    } finally {
      setBusy(false);
    }
  }, [orgId, pat]);

  const linkRepoAndAdvance = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    const full = repoFullName.trim();
    if (full.length === 0) {
      // No repo chosen → just continue (the repo is optional).
      setStep('chat');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/link-repo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoFullName: full }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const code = (j.error as string) ?? `HTTP ${res.status}`;
        const friendly =
          code === 'github-not-connected'
            ? 'GitHub ist noch nicht verbunden.'
            : code === 'repo_not_found'
              ? 'Repository nicht gefunden — bitte „owner/repo" prüfen.'
              : code === 'github_access_denied'
                ? 'Kein Zugriff auf dieses Repository.'
                : ((j.githubMessage as string) ?? code);
        throw new Error(friendly);
      }
      setStep('chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unbekannt');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, repoFullName]);

  /* ----------------------------------------------------------------- */
  /* Step 4 — ensure the default customer chat "Allgemein".            */
  /* ----------------------------------------------------------------- */
  const ensureGeneralAndFinish = useCallback(
    async (opts?: { skip?: boolean }): Promise<void> => {
      if (!workspaceId) return;
      setBusy(true);
      setError(null);
      try {
        if (!opts?.skip) {
          const res = await fetch('/api/onboarding/general-subchat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId }),
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
            throw new Error(
              (j.message as string) ?? (j.error as string) ?? `HTTP ${res.status}`,
            );
          }
          const j = (await res.json()) as { subchat: { id: string } };
          setGeneralSubchatId(j.subchat.id);
        }
        // Final landing — exactly like CreateWorkspaceCard: seed workspace+org
        // SILENTLY, then navigate hard into the scoped chat of the new customer.
        setWorkspaceId(workspaceId, workspaceOrgId ?? undefined);
        router.push(`/?ws=${encodeURIComponent(workspaceId)}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'unbekannt');
        setBusy(false);
      }
    },
    [workspaceId, workspaceOrgId, router],
  );

  /* ----------------------------------------------------------------- */
  /* Render.                                                            */
  /* ----------------------------------------------------------------- */
  return (
    <div style={containerStyle}>
      <header style={progressHeaderStyle}>
        <div style={crumbStyle}>Neuer Kunde</div>
        <div style={progressRowStyle} aria-hidden="true">
          {STEP_ORDER.map((s, i) => (
            <span
              key={s}
              style={dotStyle(i < stepIndex, i === stepIndex)}
            />
          ))}
        </div>
        <div style={progressCaptionStyle}>
          Schritt {Math.min(stepIndex + 1, STEP_ORDER.length)} von{' '}
          {STEP_ORDER.length} · {STEP_LABELS[step]}
        </div>
      </header>

      {/* Step 1 — customer --------------------------------------------- */}
      {step === 'kunde' ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Wie heißt der Kunde?</h1>
          <p style={leadStyle}>
            Jeder Kunde ist ein eigener, isolierter Container (Org · Typ
            „client").
          </p>
          <label style={fieldStyle}>
            <span style={labelStyle}>Kundenname</span>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="z. B. Beispiel GmbH"
              disabled={busy}
              autoFocus
              style={inputStyle}
            />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>Kurzbeschreibung (optional)</span>
            <input
              type="text"
              value={orgDescription}
              onChange={(e) => setOrgDescription(e.target.value)}
              placeholder="Was macht dieser Kunde?"
              disabled={busy}
              style={inputStyle}
            />
          </label>
          {error ? <div style={errorStyle}>{error}</div> : null}
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={createKunde}
              disabled={busy || orgName.trim().length < 2}
              style={primaryStyle}
            >
              {busy ? 'Lege an …' : 'Weiter'}
              {!busy ? <IconChevronRight size={15} /> : null}
            </button>
          </div>
        </section>
      ) : null}

      {/* Step 2 — workspace ------------------------------------------- */}
      {step === 'workspace' ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Erster Workspace</h1>
          <p style={leadStyle}>
            Ein Workspace in „{createdOrgName}" — hier läuft die Arbeit für
            diesen Kunden. Credentials bleiben isoliert.
          </p>
          <label style={fieldStyle}>
            <span style={labelStyle}>Workspace-Name</span>
            <input
              type="text"
              value={workspaceLabel}
              onChange={(e) => setWorkspaceLabel(e.target.value)}
              placeholder="z.B. Website-Relaunch"
              disabled={busy}
              autoFocus
              style={inputStyle}
            />
          </label>
          {error ? <div style={errorStyle}>{error}</div> : null}
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={createWorkspace}
              disabled={busy || workspaceLabel.trim().length < 2}
              style={primaryStyle}
            >
              {busy ? 'Lege an …' : 'Weiter'}
              {!busy ? <IconChevronRight size={15} /> : null}
            </button>
          </div>
        </section>
      ) : null}

      {/* Step 3 — GitHub (optional) ----------------------------------- */}
      {step === 'github' ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>GitHub verbinden</h1>
          <p style={leadStyle}>
            Optional. Verbinde ein Repo, damit der Workspace direkt Code lesen
            und schreiben kann.
          </p>

          {githubConnected ? (
            <div style={connectedRowStyle}>
              <span style={connectedIconStyle} aria-hidden="true">
                <IconCheck size={14} />
              </span>
              <span>
                Verbunden{githubLogin ? ` als ${githubLogin}` : ''}.
              </span>
            </div>
          ) : (
            <label style={fieldStyle}>
              <span style={labelStyle}>Personal Access Token</span>
              <input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="ghp_…"
                autoComplete="off"
                disabled={busy}
                style={inputStyle}
              />
              <button
                type="button"
                onClick={connectGithub}
                disabled={busy || pat.trim().length === 0}
                style={secondaryStyle}
              >
                {busy ? 'Verbinde …' : 'Verbinden'}
              </button>
            </label>
          )}

          {githubConnected ? (
            <label style={fieldStyle}>
              <span style={labelStyle}>Repository (optional)</span>
              {repoOptions.length > 0 ? (
                <select
                  value={repoFullName}
                  onChange={(e) => setRepoFullName(e.target.value)}
                  disabled={busy}
                  style={inputStyle}
                >
                  <option value="">— kein Repo —</option>
                  {repoOptions.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                      {r.isPrivate ? ' (privat)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={repoFullName}
                  onChange={(e) => setRepoFullName(e.target.value)}
                  placeholder={reposLoading ? 'Lade Repos …' : 'owner/repo'}
                  disabled={busy}
                  style={inputStyle}
                />
              )}
            </label>
          ) : null}

          {error ? <div style={errorStyle}>{error}</div> : null}
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={() => setStep('chat')}
              disabled={busy}
              style={skipStyle}
            >
              Überspringen
            </button>
            <button
              type="button"
              onClick={linkRepoAndAdvance}
              disabled={busy}
              style={primaryStyle}
            >
              {busy ? 'Verknüpfe …' : 'Weiter'}
              {!busy ? <IconChevronRight size={15} /> : null}
            </button>
          </div>
        </section>
      ) : null}

      {/* Step 4 — default customer chat "Allgemein" -------------------- */}
      {step === 'chat' ? (
        <section style={panelStyle}>
          <h1 style={titleStyle}>Default-Kanal „Allgemein"</h1>
          <p style={leadStyle}>
            Ein externer „Allgemein"-Chat als Standard-Anlaufstelle für diesen
            Kunden. Den teilbaren Link holst du später aus der Subchat-Ansicht.
          </p>
          {error ? <div style={errorStyle}>{error}</div> : null}
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={() => void ensureGeneralAndFinish({ skip: true })}
              disabled={busy}
              style={skipStyle}
            >
              Überspringen
            </button>
            <button
              type="button"
              onClick={() => void ensureGeneralAndFinish()}
              disabled={busy}
              style={primaryStyle}
            >
              {busy ? 'Lege an …' : 'Fertig & in den Chat'}
              {!busy ? <IconChevronRight size={15} /> : null}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- */
/* Styles — ONLY :root tokens, mobile-first, ≥44px tap targets.        */
/* ------------------------------------------------------------------- */

const containerStyle: CSSProperties = {
  width: '100%',
  maxWidth: 480,
  margin: '0 auto',
  marginTop: 'clamp(24px, 6vw, 64px)',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};
const progressHeaderStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};
const crumbStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};
const progressRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};
const dotStyle = (done: boolean, active: boolean): CSSProperties => ({
  width: active ? 22 : 8,
  height: 8,
  borderRadius: 999,
  background: done
    ? 'var(--a-now)'
    : active
      ? 'var(--a-now)'
      : 'var(--line-2)',
  opacity: done || active ? 1 : 1,
  transition: 'width 160ms ease, background 160ms ease',
});
const progressCaptionStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--ink-3)',
};
const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '24px 20px',
  borderRadius: 16,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-1) 92%, transparent)',
};
const titleStyle: CSSProperties = {
  fontSize: 'clamp(22px, 5vw, 28px)',
  fontWeight: 500,
  letterSpacing: '-0.02em',
  lineHeight: 1.12,
  margin: 0,
  color: 'var(--ink)',
};
const leadStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--ink-2)',
};
const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};
const inputStyle: CSSProperties = {
  minHeight: 44,
  padding: '10px 12px',
  fontSize: 16, // ≥16px prevents iOS zoom on focus
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  color: 'var(--ink)',
};
const connectedRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 44,
  padding: '8px 12px',
  borderRadius: 10,
  border: '0.5px solid color-mix(in oklab, var(--a-now) 35%, var(--line-2))',
  background: 'color-mix(in oklab, var(--a-now) 10%, transparent)',
  color: 'var(--ink)',
  fontSize: 14,
};
const connectedIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--a-now)',
};
const errorStyle: CSSProperties = {
  padding: '8px 12px',
  borderRadius: 10,
  border: '0.5px solid color-mix(in oklab, var(--a-now) 30%, var(--line-2))',
  background: 'color-mix(in oklab, var(--a-now) 8%, transparent)',
  color: 'var(--ink-2)',
  fontSize: 13,
  lineHeight: 1.45,
};
const actionRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 10,
  marginTop: 4,
  paddingBottom: 'env(safe-area-inset-bottom)',
};
const primaryStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  minHeight: 44,
  padding: '0 20px',
  borderRadius: 12,
  border: 'none',
  background: 'var(--a-now)',
  color: 'var(--sheet)',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
};
const secondaryStyle: CSSProperties = {
  minHeight: 44,
  padding: '0 18px',
  marginTop: 2,
  borderRadius: 12,
  border: '0.5px solid color-mix(in oklab, var(--a-now) 35%, var(--line-2))',
  background: 'color-mix(in oklab, var(--a-now) 10%, transparent)',
  color: 'var(--a-now)',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
const skipStyle: CSSProperties = {
  minHeight: 44,
  padding: '0 16px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontSize: 13,
  cursor: 'pointer',
};
