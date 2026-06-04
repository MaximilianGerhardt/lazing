import { ContextBand } from '@/lib/ui/cbd';
import { safeProjectDecisions } from '@/lib/events/safe-projection';
import { listWorkspaces } from '@/lib/workspaces';
import { toWorkspaceLite } from '@/lib/workspaces/resolve';
import { ScopeTabs } from '@/lib/nav/ScopeTabs';
import { DecisionsFilter } from './DecisionsFilter';

export const dynamic = 'force-dynamic';

export default async function DecisionsPage() {
  const [decisions, workspaces] = await Promise.all([
    safeProjectDecisions(),
    listWorkspaces().catch(() => []),
  ]);
  const wsLite = toWorkspaceLite(workspaces);

  return (
    <main className="sheet page-with-tabbar">
      <ScopeTabs />
      <section style={{ maxWidth: 1100, marginTop: 'clamp(24px, 5vw, 60px)' }}>
        <ContextBand
          pillVariant="own"
          pillLabel="Decision-Log"
          breadcrumb={`Alle Workspaces · ${decisions.length} Einträge`}
        />

        <div style={{ marginTop: 28 }}>
          <div
            className="t-kicker"
            style={{
              color: 'var(--a-now)',
              marginBottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span style={{ width: 32, height: 1, background: 'var(--a-now)' }} />
            Decisions · Phase 3
          </div>
          <h1
            className="t-h1"
            style={{ fontSize: 'clamp(32px, 4.5vw, 44px)', letterSpacing: '-0.02em', maxWidth: 760 }}
          >
            Jede Entscheidung ist ein{' '}
            <em style={{ fontStyle: 'italic', fontWeight: 300, color: 'var(--ink-2)' }}>Event</em>
            . Hier ist die ganze Kette.
          </h1>
          <p
            style={{
              marginTop: 16,
              maxWidth: 640,
              fontSize: 15,
              lineHeight: 1.55,
              color: 'var(--ink-2)',
            }}
          >
            Filterbar nach Workspace, Zeitraum und Volltext. Chronologisch,
            neueste zuerst. Reverted wird als Revert-Event angezeigt — niemals
            gelöscht.
          </p>
        </div>

        <DecisionsFilter decisions={decisions} workspaces={wsLite} />
      </section>
    </main>
  );
}
