'use client';

/**
 * CredentialRequestCard — ACL5-B (2026-05-24) · mobile + OAuth pass (2026-05-30).
 *
 * Surface card for credential entry when a connector needs auth.
 * Three modes (authKind, derived from the connector catalog):
 *
 *   - 'apikey' (default) → API-key entry. Secret → POST .../credential → vault.
 *   - 'oauth'            → OAuth flow. "Auth starten" button. If the OAuth
 *                          backend is (still) missing, the card honestly shows
 *                          "OAuth-Backend pending" + allows manual token entry
 *                          as a fallback (takes the same vault path).
 *   - 'none'             → engine-backed (e.g. imagegen2). No field — only an
 *                          info hint (Codex/MAX session, no key).
 *
 * Security invariants (N2 / ACL-5-B spec) — UNCHANGED:
 *   - The secret leaves the form ONLY via POST /api/connectors/[provider]/credential.
 *   - It is NEVER written into a chat reply / reply() / pushAssistant().
 *   - The surface payload (via chat SSE / emitOrUpdateCard) contains NO
 *     secret field — only provider, scopeKind, scopeId, authKind, why, hints.
 *   - The input is type="password", autoComplete="new-password" (no browser leak).
 *   - After saving: only the masked confirmation from the API response
 *     (ab••••cd format, never the plaintext).
 *
 * Mobile-first (2026-05-30):
 *   - ≥44px touch targets (inputs + buttons), minimum width 390px in mind.
 *   - One primary action, no emojis, token-only (CSS vars, no new hex).
 */

import { useState } from 'react';

// ──────────────────────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────────────────────

export type CredentialAuthKind = 'apikey' | 'oauth' | 'none';

export interface CredentialRequestCardProps {
  /** Provider slug (e.g. "heygen-avatar", "openai") — used in the POST URL. */
  provider: string;
  /** 'workspace' or 'org' — determines the isolation anchor. */
  scopeKind?: 'workspace' | 'org';
  /** ID of the active workspace (from chat context). */
  workspaceId: string;
  /** Why this key is needed (short explanation from the orchestrator). */
  why?: string;
  /** Which capability is unlocked (e.g. 'video.avatar'). No secret. */
  capability?: string;
  /**
   * Auth kind of the provider (derived from the connector catalog).
   *   'apikey' → API-key entry (default).
   *   'oauth'  → OAuth flow button (+ manual token fallback).
   *   'none'   → engine-backed, no field.
   * Unknown/missing → 'apikey' (safe default).
   */
  authKind?: CredentialAuthKind;
  /** true → engine-backed (no separate credential needed). Controls info mode. */
  engineBacked?: boolean;
  /** Verbatim hint of which value to enter (from the onboarding SOP). */
  credentialFieldHint?: string;
  /** Optional required fields from provider.config (baseUrl, version). No secret. */
  configFields?: Array<{ key: string; label: string; placeholder?: string }>;
  /** Docs link to the provider. */
  docsUrl?: string;
  /** Signup/login link (e.g. where the key is obtained). */
  signupUrl?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function scopeLabel(kind: 'workspace' | 'org' | undefined): string {
  if (kind === 'org') return 'Org-weit';
  return 'Workspace';
}

/**
 * OAuth backend wiring (2026-05-30) — HONEST STUB.
 *
 * There is (still) NO per-provider OAuth authorization endpoint in the repo. This
 * constant marks that explicitly: while `false`, the card shows, instead of a
 * fake redirect, a clear "OAuth-Backend ausstehend" hint + the
 * manual token-entry fallback (the real, working vault path).
 *
 * When a real OAuth backend is built, this is flipped to true and
 * `startOAuth()` calls GET /api/connectors/[provider]/oauth/start (the
 * server-side redirect with state + PKCE). Until then: no fake.
 */
const OAUTH_BACKEND_WIRED = false;

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────

export function CredentialRequestCard({
  provider,
  scopeKind = 'workspace',
  workspaceId,
  why,
  capability,
  authKind = 'apikey',
  engineBacked = false,
  credentialFieldHint,
  configFields,
  docsUrl,
  signupUrl,
}: CredentialRequestCardProps) {
  const [secret, setSecret] = useState('');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [masked, setMasked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // OAuth: shows the manual token fallback when the user picks "Token manuell"
  // or the backend is not wired.
  const [manualTokenMode, setManualTokenMode] = useState(false);

  const effectiveAuthKind: CredentialAuthKind = engineBacked ? 'none' : authKind;

  const handleConfigChange = (key: string, val: string): void => {
    setConfigValues((prev) => ({ ...prev, [key]: val }));
  };

  /**
   * SECURITY CONTRACT (ACL5-B):
   * The secret goes ONLY through this POST. It is written neither into reply()
   * nor into pushAssistant() nor into an SSE/ledger entry. The server
   * returns only { ok, masked } — never the secret.
   *
   * `kind`: 'api_key' for apikey mode, 'oauth' for a manually pasted
   * OAuth token (both encrypted in the same vault — the server decides
   * the credential_kind based on the provider profile; the body hint is
   * informational only).
   */
  const submit = async (): Promise<void> => {
    if (secret.length === 0) return;
    setSubmitting(true);
    setError(null);

    // Haptic hint (PWA / iOS)
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }

    try {
      // Assemble the optional config from configFields (no secret).
      const config =
        configFields && configFields.length > 0
          ? Object.fromEntries(
              configFields.map((f) => [f.key, configValues[f.key] ?? '']),
            )
          : undefined;

      const res = await fetch(
        `/api/connectors/${encodeURIComponent(provider)}/credential`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // SECURITY: no secret in the URL, logs or headers. Only in the POST body.
          body: JSON.stringify({
            secret,
            scopeKind,
            workspaceId,
            ...(config ? { config } : {}),
          }),
        },
      );

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setError(body.message ?? body.error ?? `HTTP ${res.status}`);
        return;
      }

      const body = (await res.json()) as { ok?: boolean; masked?: string };
      setMasked(body.masked ?? null);
      setDone(true);
      // Delete the secret from state immediately (no leak in re-render).
      setSecret('');

      // SECURITY: we do NOT write the plaintext into reply(). Only a neutral hint.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * OAuth start. HONEST: while OAUTH_BACKEND_WIRED === false there is no
   * real redirect — we switch into the manual token fallback and show
   * the "pending" hint. No fake window.location.
   */
  const startOAuth = (): void => {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate(10);
    }
    if (!OAUTH_BACKEND_WIRED) {
      setManualTokenMode(true);
      return;
    }
    // Wired (future): server-side authorize redirect with state+PKCE.
    window.location.href =
      `/api/connectors/${encodeURIComponent(provider)}/oauth/start` +
      `?workspaceId=${encodeURIComponent(workspaceId)}` +
      `&scopeKind=${encodeURIComponent(scopeKind)}`;
  };

  // ── Done-State ──────────────────────────────────────────────────────────────
  if (done) {
    return (
      <article
        className="srf-cred"
        data-test="surface-credential-request"
        data-state="done"
        aria-label={`${provider} verbunden`}
      >
        <div className="srf-cred__kicker">Verbunden</div>
        <div className="srf-cred__title">
          <code className="srf-cred__code">{provider}</code>
        </div>
        {masked ? (
          <p className="srf-cred__desc">
            Verschlüsselt hinterlegt ({scopeLabel(scopeKind)}){' '}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {masked}
            </span>
          </p>
        ) : (
          <p className="srf-cred__desc">
            Credential verschlüsselt im Vault gespeichert ({scopeLabel(scopeKind)}).
          </p>
        )}
      </article>
    );
  }

  // Shared header (provider + capability + why).
  const header = (
    <>
      <div className="srf-cred__title">
        <code className="srf-cred__code">{provider}</code>
      </div>

      {capability ? (
        <p className="srf-cred__meta" data-test="cred-capability">
          Schaltet frei:{' '}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {capability}
          </span>
        </p>
      ) : null}

      {why ? <p className="srf-cred__desc">{why}</p> : null}
    </>
  );

  const linksRow = (
    <>
      {signupUrl ? (
        <p className="srf-cred__meta">
          Key holen:{' '}
          <a href={signupUrl} target="_blank" rel="noreferrer" className="srf-cred__link">
            {signupUrl}
          </a>
        </p>
      ) : null}
      {docsUrl ? (
        <p className="srf-cred__meta">
          Doku:{' '}
          <a href={docsUrl} target="_blank" rel="noreferrer" className="srf-cred__link">
            {docsUrl}
          </a>
        </p>
      ) : null}
    </>
  );

  // ── 'none' — engine-backed: no credential needed ─────────────────────────────
  if (effectiveAuthKind === 'none') {
    return (
      <article
        className="srf-cred"
        data-test="surface-credential-request"
        data-authkind="none"
        aria-label={`${provider} ist engine-backed — kein Credential nötig`}
      >
        <div className="srf-cred__kicker">ENGINE-BACKED · {scopeLabel(scopeKind)}</div>
        {header}
        <p className="srf-cred__desc">
          {credentialFieldHint ??
            'Dieser Connector nutzt die bestehende Codex/MAX-Session — kein separater API-Key. LIVE-Calls bleiben über LAZYOS_CONNECTOR_LIVE gated.'}
        </p>
        {linksRow}
      </article>
    );
  }

  // ── 'oauth' — OAuth flow (with an honest backend-pending fallback) ─────────────
  if (effectiveAuthKind === 'oauth' && !manualTokenMode) {
    return (
      <article
        className="srf-cred"
        data-test="surface-credential-request"
        data-authkind="oauth"
        aria-label={`OAuth verbinden: ${provider}`}
      >
        <div className="srf-cred__kicker">OAUTH · {scopeLabel(scopeKind)}</div>
        {header}

        {!OAUTH_BACKEND_WIRED ? (
          <p
            className="srf-cred__desc"
            data-test="oauth-pending"
            style={{ color: 'var(--a-warn)' }}
          >
            OAuth-Backend ausstehend. Der direkte OAuth-Login ist serverseitig noch
            nicht verdrahtet — bis dahin kannst du dein OAuth-Token manuell
            einfügen (geht denselben verschlüsselten Vault-Weg, nie in den Chat).
          </p>
        ) : (
          <p className="srf-cred__desc">
            Verbinde {provider} per OAuth. Du wirst zum Provider weitergeleitet und
            kommst nach der Freigabe zurück. Es wird kein Token im Chat sichtbar.
          </p>
        )}

        {linksRow}

        {error ? (
          <div className="srf-cred__error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="srf-cred__actions">
          <span className="srf-cred__hint">
            {OAUTH_BACKEND_WIRED
              ? 'OAuth · Token landet verschlüsselt im Vault'
              : 'Backend pending · Token-Fallback verfügbar'}
          </span>
          <button
            type="button"
            className="srf-cred__submit"
            data-test="oauth-start-btn"
            onClick={startOAuth}
          >
            {OAUTH_BACKEND_WIRED ? 'Mit OAuth verbinden' : 'Token manuell einfügen'}
          </button>
        </div>
      </article>
    );
  }

  // ── 'apikey' (default) OR OAuth fallback (manualTokenMode) ─────────────────
  const isOauthFallback = effectiveAuthKind === 'oauth' && manualTokenMode;
  const fieldLabel = isOauthFallback
    ? `OAuth-Token für ${provider}`
    : `API-Key für ${provider}`;

  return (
    <article
      className="srf-cred"
      data-test="surface-credential-request"
      data-authkind={isOauthFallback ? 'oauth-manual' : 'apikey'}
      aria-label={`${isOauthFallback ? 'OAuth-Token' : 'API-Key'} für ${provider} eingeben`}
    >
      <div className="srf-cred__kicker">
        {isOauthFallback ? 'OAUTH-TOKEN' : 'API-KEY'} · {scopeLabel(scopeKind)}
      </div>
      {header}

      {isOauthFallback ? (
        <p className="srf-cred__meta" style={{ color: 'var(--a-warn)' }} data-test="oauth-pending">
          OAuth-Backend ausstehend — manueller Token-Fallback aktiv.
        </p>
      ) : null}

      {credentialFieldHint ? (
        <p className="srf-cred__meta">{credentialFieldHint}</p>
      ) : null}

      {linksRow}

      {/* Optional plain-text fields (baseUrl, version) — no secret */}
      {configFields && configFields.length > 0
        ? configFields.map((f) => (
            <div key={f.key} className="srf-cred__field">
              <label htmlFor={`cred-cfg-${f.key}`} className="srf-cred__label">
                {f.label}
              </label>
              <input
                id={`cred-cfg-${f.key}`}
                type="text"
                value={configValues[f.key] ?? ''}
                onChange={(e) => handleConfigChange(f.key, e.target.value)}
                placeholder={f.placeholder ?? f.key}
                className="srf-cred__input"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
              />
            </div>
          ))
        : null}

      {/*
       * SECURITY: type="password" → no echo in the DOM, no screenshot leak.
       * autoComplete="new-password" → prevents browser autofill.
       */}
      <input
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        placeholder={fieldLabel}
        className="srf-cred__input"
        autoComplete="new-password"
        spellCheck={false}
        aria-label={`Secret für ${provider}`}
        inputMode="text"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !submitting && secret.length > 0) {
            void submit();
          }
        }}
      />

      {error ? (
        <div className="srf-cred__error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="srf-cred__actions">
        <span className="srf-cred__hint">
          Encrypted Vault · Secret nur via POST · nie im Chat
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting || secret.length === 0}
          className="srf-cred__submit"
        >
          {submitting ? 'Speichert ...' : 'Speichern'}
        </button>
      </div>
    </article>
  );
}
