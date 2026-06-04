'use client';

/**
 * ConnectorCallPreviewCard — ACL5-E (2026-05-24).
 *
 * Shows the S5 preview of a connector call: provider, capability, endpoint,
 * payload keys, masked credential and a "Freigeben & ausführen" button.
 *
 * Security invariants:
 *   - No secret value in the render output or state — only the masked
 *     credentialPreview from previewCall().
 *   - Approve → POST /api/connectors/invoke (userId + workspaceId come
 *     from the board context, not from the card payload).
 *   - The card shows a clear "Simulation — LIVE aus" label when dryRun:true.
 *   - No emoji. At least 13px. Pitch-black design system.
 *
 * Approve flow:
 *   1. User clicks "Freigeben & ausführen".
 *   2. POST /api/connectors/invoke with {provider, capability, payload, workspaceId}.
 *   3. Response: { ok, dryRun?, blocked?, resultSummary } — NO secret.
 *   4. Card shows the result (done state).
 */

import { useState } from 'react';
import { useSurfaceAction } from './SurfaceActionContext';
import type { ConnectorCallPreviewPayload } from '@/lib/connectors/auto-connect';

// ──────────────────────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────────────────────

export interface ConnectorCallPreviewCardProps {
  /** Preview payload extracted from the surface payload (no secret). */
  payload: ConnectorCallPreviewPayload;
  /** Workspace ID for the /invoke POST (from chat context, not the payload). */
  workspaceId: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Invoke response type (no secret in the response)
// ──────────────────────────────────────────────────────────────────────────────

interface InvokeResponse {
  ok: boolean;
  dryRun?: boolean;
  blocked?: string;
  resultSummary?: string;
  detail?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────

export function ConnectorCallPreviewCard({
  payload,
  workspaceId,
}: ConnectorCallPreviewCardProps) {
  const { pushAssistant } = useSurfaceAction();
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<InvokeResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isDryRun = payload.dryRun || !payload.liveEnabled;

  const handleApprove = async (): Promise<void> => {
    setState('pending');
    setErrorMsg(null);

    try {
      const res = await fetch('/api/connectors/invoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // SECURITY: no secret in the body — approved:true is the user confirmation.
        body: JSON.stringify({
          provider: payload.provider,
          capability: payload.capability,
          workspaceId,
          // Payload keys from the preview — no real values (markers only).
          payload: payload.payloadSummary,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as InvokeResponse;

      if (!res.ok) {
        const errMsg = data.detail ?? data.blocked ?? `HTTP ${res.status}`;
        setState('error');
        setErrorMsg(errMsg);
        return;
      }

      setResult(data);
      setState('done');

      // Confirmation in the chat (summary only, no secret).
      if (data.ok) {
        if (data.dryRun) {
          pushAssistant(
            `**${payload.provider}.${payload.capability}** — Simulation abgeschlossen ` +
            `(LIVE aus). Aktiviere LAZYOS_CONNECTOR_LIVE für echte Ausführung.`,
          );
        } else {
          pushAssistant(
            `**${payload.provider}.${payload.capability}** ausgefuhrt. ` +
            (data.resultSummary ?? 'Ergebnis erhalten.'),
          );
        }
      } else {
        pushAssistant(
          `**${payload.provider}.${payload.capability}** blockiert: ${data.blocked ?? 'unbekannt'}.`,
        );
      }
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Netzwerkfehler');
    }
  };

  // ── Done-State ──────────────────────────────────────────────────────────────
  if (state === 'done' && result) {
    return (
      <article
        className="srf-cred"
        data-test="surface-connector-call-preview"
        data-state="done"
        aria-label={`${payload.provider} ${result.ok ? 'ausgeführt' : 'blockiert'}`}
      >
        <div className="srf-cred__kicker">
          {result.ok
            ? result.dryRun
              ? 'Simulation abgeschlossen'
              : 'Ausgeführt'
            : 'Blockiert'}
        </div>
        <div className="srf-cred__title">
          <code className="srf-cred__code">{payload.provider}</code>
          {' — '}
          <code className="srf-cred__code">{payload.capability}</code>
        </div>
        {result.resultSummary ? (
          <p className="srf-cred__desc" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {result.resultSummary}
          </p>
        ) : null}
        {!result.ok && result.blocked ? (
          <p className="srf-cred__error">Grund: {result.blocked}</p>
        ) : null}
      </article>
    );
  }

  // ── Preview-State ───────────────────────────────────────────────────────────
  return (
    <article
      className="srf-cred"
      data-test="surface-connector-call-preview"
      aria-label={`Connector-Call freigeben: ${payload.provider}.${payload.capability}`}
    >
      {/* Kicker */}
      <div className="srf-cred__kicker">
        CONNECTOR-CALL{isDryRun ? ' · SIMULATION — LIVE aus' : ''}
      </div>

      {/* Provider + Capability */}
      <div className="srf-cred__title">
        <code className="srf-cred__code">{payload.provider}</code>
        {' — '}
        <code className="srf-cred__code">{payload.capability}</code>
      </div>

      {/* Endpoint / MCP-Tool */}
      {payload.baseUrl || payload.mcpTool ? (
        <p className="srf-cred__meta">
          {payload.baseUrl ? (
            <>
              Endpoint:{' '}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {payload.baseUrl}
              </span>
            </>
          ) : null}
          {payload.mcpTool ? (
            <>
              {payload.baseUrl ? ' · ' : ''}
              MCP: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{payload.mcpTool}</span>
            </>
          ) : null}
        </p>
      ) : null}

      {/* Payload-Keys (keine Werte) */}
      {Object.keys(payload.payloadSummary).length > 0 ? (
        <p className="srf-cred__meta">
          Payload-Keys:{' '}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {Object.entries(payload.payloadSummary)
              .map(([k, t]) => `${k}: ${t}`)
              .join(', ')}
          </span>
        </p>
      ) : null}

      {/* Credential-Scope + maskierter Wert — KEIN Secret */}
      <p className="srf-cred__meta">
        Credential:{' '}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          {payload.credentialScope}
          {payload.credentialPreview ? ` (${payload.credentialPreview})` : ' (kein Credential gefunden)'}
        </span>
      </p>

      {/* Auth-Kind */}
      <p className="srf-cred__meta" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
        Auth: {payload.authKind} · Trust: {payload.currentTrust}
      </p>

      {/* DryRun-Hinweis */}
      {isDryRun ? (
        <p
          className="srf-cred__desc"
          style={{ color: 'var(--a-warn, #e6a817)', fontSize: 13 }}
        >
          Simulation — LAZYOS_CONNECTOR_LIVE ist nicht aktiv. Kein echter Netzwerk-Call.
        </p>
      ) : null}

      {/* Fehleranzeige */}
      {state === 'error' && errorMsg ? (
        <div className="srf-cred__error" role="alert">
          {errorMsg}
        </div>
      ) : null}

      {/* Actions */}
      <div className="srf-cred__actions">
        <span className="srf-cred__hint" style={{ fontSize: 12 }}>
          {isDryRun ? 'Simulation' : 'Gated: approved=true — LIVE-Flag entscheidet'}
        </span>
        <button
          type="button"
          className="srf-cred__submit"
          data-test="connector-call-approve-btn"
          disabled={state === 'pending'}
          onClick={() => void handleApprove()}
        >
          {state === 'pending'
            ? 'Wird ausgefuhrt ...'
            : isDryRun
              ? 'Simulation starten'
              : 'Freigeben & ausfuhren'}
        </button>
      </div>
    </article>
  );
}
