/**
 * /reasoning-audit/[id] — detail page for a single reasoning-audit row.
 *
 * Pattern 5 Wave 4 (2026-05-01).
 *
 * Server component. Loads directly via DB (no round-trip through /api/...). Shows:
 *   - context header (workstream, parent-ticket, phase, role)
 *   - full claim_text
 *   - sourceChunks (sourceType:sourceId table)
 *   - priorOutputs (phase + hash)
 *   - userCorrections (if present)
 *   - meta: prompt_hash, llm_provider/model, costCents, durationMs, outputTokens
 *   - verifiedStatus + verifiedAt + verifiedNote
 *   - "Drift-Check jetzt" button (client component) → POST /api/reasoning-audit/[id]/verify
 *
 * Privacy gate (V5, 2026-05-01):
 *   1. /reasoning-audit/layout.tsx redirects unauth → /login
 *   2. This page additionally does a currentUserIdResolved check
 *      (defense-in-depth, in case the layout/middleware is bypassed).
 *   3. Workspace membership check: the user needs ≥viewer role in the
 *      audit's workspace. Audits without a workspaceId are visible to all
 *      logged-in users (no workspace-specific twin leak).
 *   4. The API endpoint /api/reasoning-audit/[id] has its own 401 check.
 *
 * Surface-Library-compliant: inline styles via CSS variables, no overlays.
 */

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { CSSProperties } from 'react';

import { getDb } from '@/db/client';
import { reasoningAudit } from '@/db/schema/reasoning_audit';
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';

import { VerifyButton } from './VerifyButton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SourceChunk {
  sourceType?: string;
  sourceId?: string;
  score?: number;
  preview?: string;
}

interface PriorOutput {
  phase?: string;
  hash?: string;
  ts?: number;
}

interface UserCorrection {
  ts?: number;
  text?: string;
  by?: string;
}

function safeParseArray<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export default async function ReasoningAuditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  // Privacy-Sprint V5 (2026-05-01): auth gate (redundant to the layout for
  // defense-in-depth) + workspace membership check.
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) {
    redirect(`/login?from=${encodeURIComponent(`/reasoning-audit/${id}`)}`);
  }

  const db = getDb();
  const row = db
    .select()
    .from(reasoningAudit)
    .where(eq(reasoningAudit.id, id))
    .all()[0];

  if (!row) notFound();

  // V5: if the audit belongs to a workspace, the user must have at least
  // viewer rights there. Audits without a workspace reference
  // (legacy / system-level) are visible to every logged-in user
  // — they contain no workspace-specific twin block.
  if (row.workspaceId) {
    const role = getEffectiveWorkspaceRole(userId, row.workspaceId);
    if (!canReadWorkspace(role)) {
      notFound();
    }
  }

  const sourceChunks = safeParseArray<SourceChunk>(row.sourceChunksJson);
  const priorOutputs = safeParseArray<PriorOutput>(row.priorOutputsJson);
  const userCorrections = safeParseArray<UserCorrection>(
    row.userCorrectionsJson,
  );

  const tsMs = row.ts instanceof Date ? row.ts.getTime() : Number(row.ts);

  return (
    <main className="sheet" style={{ paddingBottom: 80, maxWidth: 1080 }}>
      <header style={pageHeaderStyle}>
        <div style={crumbStyle}>
          <Link href="/observatory" style={crumbLinkStyle}>
            ← Observatory
          </Link>
          {row.workstreamId ? (
            <>
              <span style={crumbSepStyle}>/</span>
              <Link
                href={`/workstreams/${encodeURIComponent(row.workstreamId)}`}
                style={crumbLinkStyle}
              >
                Workstream
              </Link>
            </>
          ) : null}
          {row.parentTicketId ? (
            <>
              <span style={crumbSepStyle}>/</span>
              <Link
                href={`/tickets/${encodeURIComponent(row.parentTicketId)}`}
                style={crumbLinkStyle}
              >
                {row.parentTicketId}
              </Link>
            </>
          ) : null}
        </div>
        <h1 style={titleStyle}>Reasoning-Audit · {row.phase}</h1>
        <p style={subtitleStyle}>
          {row.role} · {row.llmProvider}/{row.llmModel} ·{' '}
          {new Date(tsMs).toISOString()}
        </p>
      </header>

      <section style={cardStyle} aria-label="Verifikations-Status">
        <header style={cardHeaderStyle}>
          <span style={cardPillStyle}>Status</span>
          <strong style={cardTitleStyle}>Drift-Verifikation</strong>
        </header>
        <div style={statusGridStyle}>
          <Field label="verified_status">
            <StatusInline status={row.verifiedStatus} />
          </Field>
          <Field label="verified_at">
            {row.verifiedAt ? new Date(row.verifiedAt).toISOString() : '—'}
          </Field>
          <Field label="prompt_hash">
            <code style={codeInlineStyle}>{row.promptHash}</code>
          </Field>
          <Field label="cost">
            {(row.costCents / 100).toFixed(4)}€
          </Field>
          <Field label="duration">
            {(row.durationMs / 1000).toFixed(2)}s
          </Field>
          <Field label="output_tokens">
            {row.outputTokens ?? '—'}
          </Field>
        </div>
        {row.verifiedNote ? (
          <p style={noteStyle}>{row.verifiedNote}</p>
        ) : null}
        <div style={actionRowStyle}>
          <VerifyButton id={row.id} />
          {!row.systemPromptText || !row.userPromptText ? (
            <span style={hintStyle}>
              Klartext-Prompts nicht persistiert · Drift-Check fällt zurück auf
              Hash-Vergleich
            </span>
          ) : (
            <span style={hintStyle}>
              Re-Spawn nutzt persistierte Prompts · Cosine-Vergleich aktiv
            </span>
          )}
        </div>
      </section>

      <section style={cardStyle} aria-label="Behauptung">
        <header style={cardHeaderStyle}>
          <span style={cardPillStyle}>Claim</span>
          <strong style={cardTitleStyle}>Was hat das LLM behauptet?</strong>
        </header>
        <pre style={claimBlockStyle}>{row.claimText}</pre>
      </section>

      <section style={cardStyle} aria-label="Quellen">
        <header style={cardHeaderStyle}>
          <span style={cardPillStyle}>Sources</span>
          <strong style={cardTitleStyle}>
            sourceChunks ({sourceChunks.length})
          </strong>
        </header>
        {sourceChunks.length === 0 ? (
          <p style={emptyStyle}>
            Keine Source-Chunks aufgezeichnet. Möglich: Phase ohne RAG-Routing
            oder Provider hat keine Citations geliefert.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>ID</th>
                <th style={thStyle}>Score</th>
                <th style={thStyle}>Preview</th>
              </tr>
            </thead>
            <tbody>
              {sourceChunks.map((c, idx) => (
                <tr key={`src-${idx}`}>
                  <td style={tdStyle}>{c.sourceType ?? '—'}</td>
                  <td style={{ ...tdStyle, ...codeColStyle }}>
                    {c.sourceId ?? '—'}
                  </td>
                  <td style={tdStyle}>
                    {typeof c.score === 'number' ? c.score.toFixed(3) : '—'}
                  </td>
                  <td style={tdStyle}>{c.preview ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={cardStyle} aria-label="Vorherige Outputs">
        <header style={cardHeaderStyle}>
          <span style={cardPillStyle}>Prior</span>
          <strong style={cardTitleStyle}>
            priorOutputs ({priorOutputs.length})
          </strong>
        </header>
        {priorOutputs.length === 0 ? (
          <p style={emptyStyle}>
            Keine vorherigen Outputs referenziert. Phase ist V1 oder
            Standalone-Spawn.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Phase</th>
                <th style={thStyle}>Hash</th>
                <th style={thStyle}>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              {priorOutputs.map((p, idx) => (
                <tr key={`prior-${idx}`}>
                  <td style={tdStyle}>{p.phase ?? '—'}</td>
                  <td style={{ ...tdStyle, ...codeColStyle }}>
                    {p.hash ?? '—'}
                  </td>
                  <td style={tdStyle}>
                    {p.ts ? new Date(p.ts).toISOString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {userCorrections.length > 0 ? (
        <section style={cardStyle} aria-label="User-Korrekturen">
          <header style={cardHeaderStyle}>
            <span style={cardPillStyle}>Sniper</span>
            <strong style={cardTitleStyle}>
              userCorrections ({userCorrections.length})
            </strong>
          </header>
          <ul style={listStyle}>
            {userCorrections.map((u, idx) => (
              <li key={`uc-${idx}`} style={correctionItemStyle}>
                <div style={correctionMetaStyle}>
                  {u.ts ? new Date(u.ts).toISOString() : '—'}
                  {u.by ? ` · ${u.by}` : ''}
                </div>
                <div style={correctionTextStyle}>{u.text ?? ''}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div style={fieldStyle}>
      <span style={fieldLabelStyle}>{label}</span>
      <span style={fieldValueStyle}>{children}</span>
    </div>
  );
}

function StatusInline({
  status,
}: {
  status: string | null;
}): React.JSX.Element {
  const palette: Record<
    string,
    { fg: string; border: string; label: string }
  > = {
    ok: { fg: '#1f9d55', border: '#1f9d55', label: 'verifiziert' },
    drift: { fg: '#c98a00', border: '#c98a00', label: 'drift' },
    fabricated: {
      fg: '#c0392b',
      border: '#c0392b',
      label: 'halluziniert',
    },
  };
  const p = status ? palette[status] : null;
  if (!p) {
    return (
      <span style={{ ...inlineBadgeStyle, color: 'var(--ink-3)' }}>
        unverified
      </span>
    );
  }
  return (
    <span
      style={{
        ...inlineBadgeStyle,
        color: p.fg,
        borderColor: p.border,
      }}
    >
      {p.label}
    </span>
  );
}

// ────────────────────────────── Styles ──────────────────────────────

const pageHeaderStyle: CSSProperties = {
  marginBottom: 24,
  paddingTop: 24,
};

const crumbStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
  marginBottom: 8,
};

const crumbLinkStyle: CSSProperties = {
  color: 'var(--ink-2)',
  textDecoration: 'none',
};

const crumbSepStyle: CSSProperties = {
  color: 'var(--ink-3)',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 22,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
};

const subtitleStyle: CSSProperties = {
  margin: '4px 0 0 0',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-3)',
};

const cardStyle: CSSProperties = {
  marginTop: 16,
  padding: 'clamp(16px, 2.5vw, 24px)',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const cardPillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '2px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--ink-3)',
  color: 'var(--ink-2)',
};

const cardTitleStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--ink)',
};

const statusGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 12,
};

const fieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const fieldLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const fieldValueStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink)',
};

const inlineBadgeStyle: CSSProperties = {
  display: 'inline-block',
  padding: '2px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const codeInlineStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  background: 'var(--sheet)',
  padding: '1px 6px',
  borderRadius: 4,
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink-2)',
};

const noteStyle: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  fontSize: 13,
  color: 'var(--ink-2)',
  lineHeight: 1.5,
};

const actionRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

const hintStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const claimBlockStyle: CSSProperties = {
  margin: 0,
  padding: 14,
  borderRadius: 10,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  lineHeight: 1.55,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 480,
  overflow: 'auto',
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  borderBottom: '0.5px solid var(--line-2)',
};

const tdStyle: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '0.5px solid var(--line-2)',
  color: 'var(--ink-2)',
  verticalAlign: 'top',
};

const codeColStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
};

const emptyStyle: CSSProperties = {
  margin: 0,
  padding: '12px 14px',
  borderRadius: 8,
  border: '0.5px dashed var(--line-2)',
  color: 'var(--ink-3)',
  fontSize: 12,
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const correctionItemStyle: CSSProperties = {
  padding: 12,
  borderRadius: 8,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
};

const correctionMetaStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  marginBottom: 4,
};

const correctionTextStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
};
