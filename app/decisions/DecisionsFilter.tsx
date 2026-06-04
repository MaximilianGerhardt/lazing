'use client';

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { Pill, PillRow } from '@/lib/ui/pil';
import { migrateSegmentToWorkspace } from '@/lib/events/types';
import type { DecisionProjection, SegmentId } from '@/lib/events/types';
import {
  workspaceAccentVariant,
  workspaceLabel,
  type WorkspaceLite,
} from '@/lib/workspaces/resolve';

type Range = 'today' | '7d' | '30d' | 'all';

const RANGE_LABEL: Record<Range, string> = {
  today: 'Heute',
  '7d': '7 Tage',
  '30d': '30 Tage',
  all: 'Alle',
};

export interface DecisionsFilterProps {
  decisions: DecisionProjection[];
  /** Echte Workspace-Liste (aus listWorkspaces) für Label/Accent-Auflösung. */
  workspaces: WorkspaceLite[];
}

export function DecisionsFilter({ decisions, workspaces }: DecisionsFilterProps) {
  const [activeSegments, setActiveSegments] = useState<Set<SegmentId>>(
    new Set(),
  );
  const [range, setRange] = useState<Range>('all');
  const [query, setQuery] = useState<string>('');
  // `now` is pinned at mount so useMemo stays pure (React 19 purity rule).
  // A quiet minute-level refresh keeps "Heute" / "7 Tage" windows honest
  // without bumping on every render. We sync from an external clock
  // (Date.now), so setState-in-effect is exactly the intended pattern.
  const [now, setNow] = useState<number>(() => 0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const iv = window.setInterval(tick, 60_000);
    // Schedule initial sync out of the commit phase.
    const raf = window.requestAnimationFrame(tick);
    return () => {
      window.clearInterval(iv);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  const filtered = useMemo(() => {
    const cutoff =
      now === 0
        ? 0
        : range === 'today'
          ? now - 86_400_000
          : range === '7d'
            ? now - 7 * 86_400_000
            : range === '30d'
              ? now - 30 * 86_400_000
              : 0;

    const q = query.trim().toLowerCase();

    return decisions
      .filter((d) => {
        if (
          activeSegments.size > 0 &&
          !activeSegments.has(migrateSegmentToWorkspace(d.segmentId))
        ) {
          return false;
        }
        if (cutoff > 0 && d.createdAt < cutoff) return false;
        if (q.length > 0) {
          const hay = `${d.headline} ${d.sub ?? ''} ${d.id}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [decisions, activeSegments, range, query, now]);

  const toggleSegment = (s: SegmentId) => {
    setActiveSegments((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  // Datengetriebene Workspace-Filter: nur Workspaces, die TATSÄCHLICH
  // Decisions haben — nie leere Pills, nie Phantasie-Kunden. Legacy-`@`-
  // segmentIds werden migriert + dedupliziert.
  const availableWorkspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of decisions) {
      const wsId = migrateSegmentToWorkspace(d.segmentId);
      if (!seen.has(wsId)) {
        seen.set(wsId, workspaceLabel(d.segmentId, workspaces));
      }
    }
    return [...seen.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'de'));
  }, [decisions, workspaces]);

  // Stale-Filter-Schutz: ändern sich die Decisions und ein aktiver Workspace-
  // Filter kommt nicht mehr vor, den orphan'd Filter entfernen — sonst
  // versteckt er stumm ALLE Einträge ohne sichtbare aktive Pille.
  useEffect(() => {
    setActiveSegments((prev) => {
      if (prev.size === 0) return prev;
      const valid = new Set(availableWorkspaces.map((w) => w.id));
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [availableWorkspaces]);

  return (
    <div>
      <div style={{ marginTop: 24, display: 'grid', gap: 14 }}>
        {availableWorkspaces.length > 0 ? (
          <div>
            <div style={filterLabel}>Workspace</div>
            <PillRow>
              {availableWorkspaces.map((w) => {
                const active = activeSegments.has(w.id);
                return (
                  <Pill
                    key={w.id}
                    variant={
                      active ? workspaceAccentVariant(w.id, workspaces) : 'north'
                    }
                    onClick={() => toggleSegment(w.id)}
                    ariaLabel={`Workspace ${w.label} umschalten`}
                  >
                    {active ? '● ' : ''}
                    {w.label}
                  </Pill>
                );
              })}
            </PillRow>
          </div>
        ) : null}

        <div>
          <div style={filterLabel}>Zeitraum</div>
          <PillRow>
            {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
              <Pill
                key={r}
                variant={range === r ? 'own' : 'north'}
                onClick={() => setRange(r)}
                ariaLabel={`Zeitraum ${RANGE_LABEL[r]} wählen`}
              >
                {range === r ? '● ' : ''}
                {RANGE_LABEL[r]}
              </Pill>
            ))}
          </PillRow>
        </div>

        <div>
          <div style={filterLabel}>Suche</div>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Headline, Sub oder ID durchsuchen …"
            style={searchStyle}
            aria-label="Decisions durchsuchen"
          />
        </div>
      </div>

      <div style={{ marginTop: 28, fontSize: 12, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', letterSpacing: '0.02em' }}>
        {filtered.length} · {filtered.length === 1 ? 'Decision' : 'Decisions'}
      </div>

      {filtered.length === 0 ? (
        <div style={emptyStateStyle}>
          Keine Decisions. Sobald du in <code style={codeStyle}>/</code> eine
          Entscheidungs-Frage stellst, landet sie hier.
        </div>
      ) : (
        <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
          {filtered.map((d) => (
            <DecisionRow key={d.id} decision={d} workspaces={workspaces} />
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionRow({
  decision,
  workspaces,
}: {
  decision: DecisionProjection;
  workspaces: WorkspaceLite[];
}) {
  const chosen = decision.options.find((o) => o.id === decision.chosenOptionId);
  const dateStr = new Date(decision.decidedAt ?? decision.createdAt).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });

  return (
    <article style={rowStyle} aria-label={`Decision ${decision.id}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 120 }}>
        <Pill variant={workspaceAccentVariant(decision.segmentId, workspaces)}>
          {workspaceLabel(decision.segmentId, workspaces)}
        </Pill>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--ink-3)',
            letterSpacing: '0.02em',
          }}
        >
          {decision.id} · {dateStr}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: 'var(--ink)', letterSpacing: '-0.01em', lineHeight: 1.4 }}>
          {decision.headline}
        </div>
        {decision.sub ? (
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.45 }}>
            {decision.sub}
          </div>
        ) : null}
      </div>
      {chosen ? (
        <div style={chosenBadgeStyle} aria-label={`Gewählt: ${chosen.label}`}>
          {chosen.label}
        </div>
      ) : (
        <div style={{ ...chosenBadgeStyle, color: 'var(--ink-3)', background: 'transparent' }}>
          offen
        </div>
      )}
    </article>
  );
}

const filterLabel: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-3)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 8,
  fontFamily: 'var(--font-mono)',
};

const searchStyle: CSSProperties = {
  width: '100%',
  maxWidth: 480,
  padding: '10px 14px',
  border: '0.5px solid var(--line-2)',
  borderRadius: 12,
  background: 'var(--sheet-2)',
  color: 'var(--ink)',
  fontSize: 14,
  fontFamily: 'inherit',
  letterSpacing: '-0.01em',
  outline: 'none',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 20,
  padding: '16px 18px',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  flexWrap: 'wrap',
};

const chosenBadgeStyle: CSSProperties = {
  alignSelf: 'center',
  padding: '8px 14px',
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--a-now) 14%, transparent)',
  color: 'var(--a-now)',
  fontSize: 12,
  letterSpacing: '-0.01em',
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'nowrap',
};

const emptyStateStyle: CSSProperties = {
  marginTop: 28,
  padding: 32,
  textAlign: 'center',
  border: '0.5px dashed var(--line-2)',
  borderRadius: 14,
  color: 'var(--ink-2)',
  fontSize: 14,
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  padding: '2px 6px',
  borderRadius: 4,
  background: 'var(--sheet-2)',
  color: 'var(--a-now)',
  fontSize: 12,
};
