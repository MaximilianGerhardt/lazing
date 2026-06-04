'use client';

import {
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { Pill } from '@/lib/ui/pil';
import type { TicketProjection } from '@/lib/events/types';
import {
  workspaceAccentVariant,
  workspaceLabel,
  type WorkspaceLite,
} from '@/lib/workspaces/resolve';

export interface MonthGridProps {
  /**
   * Tickets with a pre-computed `absoluteDueDayKey` (`YYYY-MM-DD`)
   * per entry. Undated tickets are already filtered out by the
   * caller so this component stays purely presentational.
   */
  entries: Array<{ ticket: TicketProjection; dayKey: string }>;
  /**
   * 30 consecutive day keys starting today. Pre-computed on the
   * server so server/client share the same wall-clock.
   */
  dayKeys: string[];
  /** Readable "dd.mm." label per day key. */
  dayLabels: Record<string, string>;
  /** ISO week-day index (0=Mon..6=Sun) per day key. */
  dayWeekIndex: Record<string, number>;
  /** Echte Workspace-Liste für Label/Accent-Auflösung (statt Fake-Segmente). */
  workspaces: WorkspaceLite[];
}

export function MonthGrid({
  entries,
  dayKeys,
  dayLabels,
  dayWeekIndex,
  workspaces,
}: MonthGridProps) {
  const [openDay, setOpenDay] = useState<string | null>(null);

  // Bucket tickets per day-key.
  const byDay = useMemo(() => {
    const m = new Map<string, TicketProjection[]>();
    for (const e of entries) {
      const bucket = m.get(e.dayKey) ?? [];
      bucket.push(e.ticket);
      m.set(e.dayKey, bucket);
    }
    return m;
  }, [entries]);

  // Pad the grid so the first day aligns with Monday.
  const firstKey = dayKeys[0];
  const leadingPad = firstKey ? (dayWeekIndex[firstKey] ?? 0) : 0;

  return (
    <div>
      <div style={weekdayRowStyle} aria-hidden="true">
        {['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((w) => (
          <div key={w} style={weekdayCellStyle}>{w}</div>
        ))}
      </div>

      <div style={gridStyle} role="grid" aria-label="Monatskalender">
        {Array.from({ length: leadingPad }, (_, i) => (
          <div key={`pad-${i}`} style={padCellStyle} aria-hidden="true" />
        ))}

        {dayKeys.map((key, idx) => {
          const items = byDay.get(key) ?? [];
          const isToday = idx === 0;
          const isOpen = openDay === key;
          const count = items.length;
          // Visuelles Label auf Mobile kurz halten: nur die Tageszahl
          // ("dd"). Das volle "dd.mm." landet weiterhin in aria-label +
          // title fuer Screen-Reader und Desktop-Tooltip. Sonst sprengt
          // der nicht-umbrechbare 6-Zeichen-String die 7er-Grid-Zellen
          // bei 375px / 390px viewports.
          const shortLabel = (dayLabels[key] ?? '').split('.')[0] ?? '';

          return (
            <button
              key={key}
              type="button"
              onClick={() => setOpenDay(isOpen ? null : key)}
              aria-expanded={isOpen}
              aria-label={`${dayLabels[key]} · ${count} ${count === 1 ? 'Termin' : 'Termine'}`}
              title={dayLabels[key]}
              style={{
                ...cellStyle,
                borderColor: isToday
                  ? 'var(--a-now)'
                  : isOpen
                    ? 'var(--ink-2)'
                    : 'var(--line-2)',
                background: isOpen ? 'var(--sheet-2)' : 'transparent',
                cursor: count > 0 ? 'pointer' : 'default',
              }}
            >
              <div style={cellDateStyle}>
                <span aria-hidden="true">{shortLabel}</span>
                {isToday ? (
                  <span style={todayDotStyle} aria-label="Heute" />
                ) : null}
              </div>
              {count > 0 ? (
                <div style={cellCountStyle}>{count}</div>
              ) : null}
            </button>
          );
        })}
      </div>

      {openDay ? (
        <DayDisclosure
          dayLabel={dayLabels[openDay] ?? openDay}
          items={byDay.get(openDay) ?? []}
          workspaces={workspaces}
          onClose={() => setOpenDay(null)}
        />
      ) : null}
    </div>
  );
}

function DayDisclosure({
  dayLabel,
  items,
  workspaces,
  onClose,
}: {
  dayLabel: string;
  items: TicketProjection[];
  workspaces: WorkspaceLite[];
  onClose: () => void;
}) {
  return (
    <div style={disclosureStyle} role="region" aria-label={`Termine am ${dayLabel}`}>
      <div style={disclosureHeaderStyle}>
        <div style={{ fontSize: 14, letterSpacing: '-0.01em' }}>
          <b style={{ color: 'var(--ink)', fontWeight: 500 }}>{dayLabel}</b>
          <span style={{ color: 'var(--ink-3)', marginLeft: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {items.length} {items.length === 1 ? 'Termin' : 'Termine'}
          </span>
        </div>
        <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Schließen">
          schließen
        </button>
      </div>

      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink-3)', padding: '12px 0' }}>
          Nichts an diesem Tag.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {items.map((t) => (
            <div key={t.id} style={listRowStyle}>
              <Pill variant={workspaceAccentVariant(t.segmentId, workspaces)}>
                {workspaceLabel(t.segmentId, workspaces)}
              </Pill>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: 'var(--ink)', letterSpacing: '-0.01em' }}>
                  {t.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {t.id}
                  {t.prio ? ` · ${t.prio}` : ''}
                  {t.assignee ? ` · ${t.assignee}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const weekdayRowStyle: CSSProperties = {
  display: 'grid',
  // `minmax(0, 1fr)` statt `1fr` verhindert, dass min-content
  // (nicht-umbrechbare Labels) die Spalten ueber den Container
  // hinaus zieht — sonst reisst das 7er-Raster auf Mobile auf.
  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
  gap: 'clamp(4px, 1.2vw, 6px)',
  marginTop: 20,
  marginBottom: 8,
};

const weekdayCellStyle: CSSProperties = {
  textAlign: 'center',
  fontSize: 11,
  color: 'var(--ink-3)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  fontFamily: 'var(--font-mono)',
  minWidth: 0,
  overflow: 'hidden',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  // siehe weekdayRowStyle — `minmax(0, 1fr)` ist Pflicht fuer
  // narrow viewports, damit Zellen unter ihre min-content-Breite
  // schrumpfen duerfen.
  gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
  gap: 'clamp(4px, 1.2vw, 6px)',
};

const cellStyle: CSSProperties = {
  aspectRatio: '1 / 1',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  padding: 'clamp(4px, 1.5vw, 8px)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 10,
  color: 'var(--ink-2)',
  fontFamily: 'inherit',
  textAlign: 'left',
  transition: 'border-color 120ms ease, background 120ms ease',
  // Kein Overflow aus der Zelle — Inhalte werden visuell geclippt
  // statt das Grid zu sprengen.
  minWidth: 0,
  overflow: 'hidden',
};

const padCellStyle: CSSProperties = {
  aspectRatio: '1 / 1',
  minWidth: 0,
};

const cellDateStyle: CSSProperties = {
  fontSize: 'clamp(10px, 2.6vw, 12px)',
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.02em',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
};

const todayDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--a-now)',
  boxShadow: '0 0 6px var(--a-now)',
};

const cellCountStyle: CSSProperties = {
  alignSelf: 'flex-end',
  padding: '1px 6px',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--a-now) 18%, transparent)',
  color: 'var(--a-now)',
  fontSize: 'clamp(9px, 2.4vw, 11px)',
  fontFamily: 'var(--font-mono)',
  lineHeight: 1.2,
  // Zaehler soll niemals die Zelle sprengen.
  maxWidth: '100%',
  overflow: 'hidden',
};

const disclosureStyle: CSSProperties = {
  marginTop: 20,
  padding: 20,
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
};

const disclosureHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 14,
  paddingBottom: 12,
  borderBottom: '0.5px dashed var(--line-2)',
};

const closeBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink-3)',
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.02em',
};

const listRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 10,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
};
