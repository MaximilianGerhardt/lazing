/**
 * /workspaces/[id] — workspace detail with tab navigation.
 *
 * Tabs (?tab=…):
 *   - overview (default) — stats + editor (label/description/notes/sensitivity)
 *   - branding           — visual showcase: accents, fonts, UI elements
 *   - credentials        — encrypted key-value storage (Vercel style)
 *
 * Style language: /design — Apple-keynote hero, generous whitespace.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';

import { getDb } from '@/db/client';
import { suggestOrgForWorkspace } from '@/lib/orgs/suggest';
import { OrgBootstrap } from '@/lib/nav/OrgBootstrap';
import { orgBootstrapEnabled } from '@/lib/nav/org-bootstrap.server';
import { ContextBand } from '@/lib/ui/cbd';
import { WorkspaceEditor } from './WorkspaceEditor';
import { BrandingEditor } from './BrandingEditor';
import { CredentialsManager } from './CredentialsManager';
import { CloudBrowserPanel } from './CloudBrowserPanel';
import { RagStatusCard } from './RagStatusCard';
import { WorkspaceFoldersEditor } from '@/lib/workspaces/WorkspaceFoldersEditor';

export const dynamic = 'force-dynamic';

type Tab = 'overview' | 'folders' | 'rag' | 'branding' | 'credentials' | 'cloud';

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Übersicht',
  folders: 'Ordner',
  rag: 'RAG',
  cloud: 'Cloud',
  branding: 'Branding',
  credentials: 'Credentials',
};

interface WorkspaceRow {
  id: string;
  label: string;
  accent: string;
  path: string;
  sensitivity: string | null;
  archived: number | null;
  description: string | null;
  notes: string | null;
  notes_updated_at: number | null;
  notes_source: string | null;
  organization_id: string | null;
  logo_url: string | null;
  wordmark_url: string | null;
  brand_colors: string | null;
  brand_voice: string | null;
  email_signature: string | null;
  canonical_domain: string | null;
  created_at: number;
  updated_at: number;
}

function parseBrandColors(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 3);
  } catch {
    return [];
  }
}

export default async function WorkspaceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id: rawId } = await params;
  const sp = await searchParams;
  const id = decodeURIComponent(rawId);
  const tab: Tab =
    sp.tab === 'branding' ||
    sp.tab === 'credentials' ||
    sp.tab === 'folders' ||
    sp.tab === 'rag' ||
    sp.tab === 'cloud'
      ? sp.tab
      : 'overview';

  if (!/^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id)) {
    notFound();
  }

  let row: WorkspaceRow | undefined;
  try {
    const db = getDb();
    row = db.$raw
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
  } catch (err) {
    console.error('[workspaces/[id]] DB read failed', err);
  }

  if (!row) notFound();

  // Stats for the header
  let openTickets = 0;
  let totalWorkstreams = 0;
  try {
    const db = getDb();
    const tRow = db.$raw
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE entity_type='ticket' AND segment_id=? AND event_type='created'",
      )
      .get(id) as { c?: number } | undefined;
    openTickets = tRow?.c ?? 0;
    const wRow = db.$raw
      .prepare("SELECT COUNT(*) AS c FROM workstreams WHERE workspace_id=?")
      .get(id) as { c?: number } | undefined;
    totalWorkstreams = wRow?.c ?? 0;
  } catch {
    /* ignore */
  }

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      {/* Nav-Fix D: align org context to this workspace (no redirect). */}
      {orgBootstrapEnabled() && row.organization_id ? (
        <OrgBootstrap organizationId={row.organization_id} />
      ) : null}
      <header style={heroStyle}>
        <ContextBand
          pillLabel={row.label}
          breadcrumb={`Workspace · ${id}`}
        />
        <h1 className="t-h2" style={titleStyle}>
          {row.label}
        </h1>
        {row.description ? (
          <p style={descStyle}>{row.description}</p>
        ) : (
          <p style={{ ...descStyle, fontStyle: 'italic', color: 'var(--ink-3)' }}>
            Keine Kurzbeschreibung — füg unter „Übersicht" eine hinzu.
          </p>
        )}

        <div style={statsRowStyle}>
          <Stat label="Tickets erstellt" value={String(openTickets)} />
          <Stat label="Workstreams" value={String(totalWorkstreams)} />
          <Stat label="Sensitivity" value={row.sensitivity ?? 'low'} />
          <Stat label="Pfad" value={row.path || '—'} mono />
        </div>
      </header>

      <nav style={tabsRowStyle} aria-label="Workspace-Tabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <Link
            key={t}
            href={
              t === 'overview'
                ? `/workspaces/${encodeURIComponent(id)}`
                : `/workspaces/${encodeURIComponent(id)}?tab=${t}`
            }
            style={tabBtnStyle(tab === t)}
            aria-current={tab === t ? 'page' : undefined}
            replace
          >
            {TAB_LABELS[t]}
          </Link>
        ))}
      </nav>

      <section style={tabContentStyle}>
        {tab === 'overview' ? (
          <WorkspaceEditor
            workspace={{
              id: row.id,
              label: row.label,
              description: row.description ?? '',
              notes: row.notes ?? '',
              sensitivity: row.sensitivity ?? 'low',
              notesSource: row.notes_source,
              notesUpdatedAt: row.notes_updated_at,
              organizationId: row.organization_id,
              orgSuggestion: suggestOrgForWorkspace(row.id),
            }}
          />
        ) : null}

        {tab === 'branding' ? (
          row.sensitivity === 'high' || id === '__root__' ? (
            <div style={{
              padding: 'clamp(20px, 3vw, 36px)',
              borderRadius: 16,
              border: '0.5px dashed var(--line-2)',
              background: 'color-mix(in oklab, var(--sheet-2) 60%, transparent)',
              color: 'var(--ink-3)',
              fontSize: 14,
              lineHeight: 1.55,
              maxWidth: 640,
            }}>
              <strong style={{ color: 'var(--ink-2)' }}>Branding nicht relevant</strong>
              <p style={{ margin: '8px 0 0' }}>
                Dieser Workspace ist privat oder ein Root-Container. Brand-Identität
                (Logo, Markenfarben, Voice) ist nur für Kunden- und Projekt-Workspaces
                relevant — also Sachen die Outbound-Communication, PDFs oder Stripe-
                Receipts erzeugen.
              </p>
            </div>
          ) : (
            <BrandingEditor
              workspaceId={id}
              initial={{
                logoUrl: row.logo_url,
                wordmarkUrl: row.wordmark_url,
                brandColors: parseBrandColors(row.brand_colors),
                brandVoice: row.brand_voice,
                emailSignature: row.email_signature,
                canonicalDomain: row.canonical_domain,
              }}
            />
          )
        ) : null}

        {tab === 'folders' ? (
          <WorkspaceFoldersEditor workspaceId={id} />
        ) : null}

        {tab === 'rag' ? (
          // RAG index status + re-index trigger (TG-2 audit fix · 2026-05-28).
          // Mobile-first, token-only — RagStatusCard uses only var(--ink*),
          // var(--sheet*), var(--line*) + var(--a-danger) fallback, no
          // new hex values. Client component, loads /api/rag/status onmount.
          <RagStatusCard workspaceId={id} />
        ) : null}

        {tab === 'credentials' ? (
          <CredentialsManager workspaceId={id} />
        ) : null}

        {tab === 'cloud' ? (
          <CloudBrowserPanel
            workspaceId={id}
            workspaceLabel={row.label}
            sensitivity={row.sensitivity ?? 'low'}
            archived={Boolean(row.archived)}
          />
        ) : null}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={statStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={mono ? statValueMonoStyle : statValueStyle}>{value}</div>
    </div>
  );
}

const heroStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 'clamp(28px, 4vw, 56px)',
};

const titleStyle: CSSProperties = {
  marginTop: 18,
  fontSize: 'clamp(34px, 5vw, 60px)',
  letterSpacing: '-0.035em',
  lineHeight: 1.02,
};

const descStyle: CSSProperties = {
  marginTop: 14,
  maxWidth: 720,
  fontSize: 'clamp(15px, 1.7vw, 18px)',
  lineHeight: 1.55,
  color: 'var(--ink-2)',
  letterSpacing: '-0.005em',
};

const statsRowStyle: CSSProperties = {
  marginTop: 32,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 14,
};

const statStyle: CSSProperties = {
  padding: '14px 16px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
};

const statLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const statValueStyle: CSSProperties = {
  marginTop: 6,
  fontSize: 16,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const statValueMonoStyle: CSSProperties = {
  ...statValueStyle,
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const tabsRowStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 'clamp(40px, 6vw, 72px)',
  display: 'flex',
  gap: 4,
  padding: 4,
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
  alignSelf: 'flex-start',
  width: 'fit-content',
};

function tabBtnStyle(active: boolean): CSSProperties {
  return {
    padding: '8px 18px',
    borderRadius: 999,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    textDecoration: 'none',
    color: active ? 'var(--ink)' : 'var(--ink-3)',
    background: active
      ? 'color-mix(in oklab, var(--a-now) 18%, transparent)'
      : 'transparent',
    transition: 'background 160ms, color 160ms',
  };
}

const tabContentStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 28,
};
