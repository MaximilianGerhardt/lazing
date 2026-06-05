import type { CSSProperties } from 'react';
import { ContextBand } from '@/lib/ui/cbd';
import { Pill } from '@/lib/ui/pil';
import { Ticket } from '@/lib/ui/tck';
import { safeProjectTickets } from '@/lib/events/safe-projection';
import type { TicketProjection } from '@/lib/events/types';
import { listWorkspaces } from '@/lib/workspaces';
import {
  toWorkspaceLite,
  workspaceAccentVariant,
  workspaceLabel,
} from '@/lib/workspaces/resolve';
import { MonthGrid } from './MonthGrid';
import { TodayQuickAction } from './TodayQuickAction';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

/**
 * A ticket carries its `due` date as a "dd.mm." string. We need
 * an absolute day key to bucket it into the calendar. This helper
 * expands the month/day into the NEXT occurrence on/after `today`
 * within a 12-month window — so "14.05." renders into this year's
 * May 14th if that is in the future, or next year's if it is in
 * the past. Tickets without `due` drop out entirely.
 */
function resolveDueKey(
  due: string | undefined,
  today: Date,
): string | null {
  if (!due) return null;
  const parts = due.split('.');
  const d = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(d) || !Number.isFinite(m)) return null;

  const year = today.getFullYear();
  const candidate = new Date(year, m - 1, d, 12, 0, 0, 0);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);

  // Accept past dates up to 7 days back so the UI does not lose
  // "due yesterday" items immediately; otherwise bump to next year.
  const diff = (candidate.getTime() - todayStart.getTime()) / DAY_MS;
  if (diff < -7) {
    candidate.setFullYear(year + 1);
  }
  return dayKey(candidate);
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayLabel(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

/** JS getDay(): 0=Sun..6=Sat. Convert to 0=Mon..6=Sun. */
function mondayIndex(d: Date): number {
  const js = d.getDay();
  return js === 0 ? 6 : js - 1;
}

export default async function CalendarPage() {
  const [tickets, workspaces] = await Promise.all([
    safeProjectTickets(),
    listWorkspaces().catch(() => []),
  ]);
  const wsLite = toWorkspaceLite(workspaces);
  const today = new Date();
  const todayKeyStr = dayKey(today);

  // Resolve each ticket to an absolute day key (or null → drop).
  const entries: Array<{ ticket: TicketProjection; dayKey: string }> = [];
  for (const t of tickets) {
    if (t.status === 'done') continue;
    const k = resolveDueKey(t.due, today);
    if (!k) continue;
    entries.push({ ticket: t, dayKey: k });
  }

  // Sort entries by day + priority for stable ordering.
  entries.sort((a, b) => {
    if (a.dayKey !== b.dayKey) return a.dayKey.localeCompare(b.dayKey);
    return prioWeight(a.ticket.prio) - prioWeight(b.ticket.prio);
  });

  // Day keys for the next 30 days (today + 29).
  const dayKeys: string[] = [];
  const dayLabels: Record<string, string> = {};
  const dayWeekIndex: Record<string, number> = {};
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i, 12, 0, 0, 0);
    const k = dayKey(d);
    dayKeys.push(k);
    dayLabels[k] = dayLabel(d);
    dayWeekIndex[k] = mondayIndex(d);
  }

  const todayItems = entries
    .filter((e) => e.dayKey === todayKeyStr)
    .map((e) => e.ticket);

  const weekKeys = new Set(dayKeys.slice(0, 7));
  const weekByDay = new Map<string, TicketProjection[]>();
  for (const e of entries) {
    if (!weekKeys.has(e.dayKey)) continue;
    const bucket = weekByDay.get(e.dayKey) ?? [];
    bucket.push(e.ticket);
    weekByDay.set(e.dayKey, bucket);
  }

  const firstToday = todayItems[0];

  const monthEntryCount = entries.filter((e) => dayKeys.includes(e.dayKey)).length;

  return (
    <main className="sheet page-with-tabbar">
      <section style={{ maxWidth: 1100, marginTop: 'clamp(24px, 5vw, 60px)' }}>
        <ContextBand
          pillVariant="own"
          pillLabel="Kalender"
          breadcrumb={`Heute · ${todayItems.length} · Woche · ${Array.from(weekByDay.values()).reduce((a, b) => a + b.length, 0)} · 30 Tage · ${monthEntryCount}`}
        />

        <div style={{ marginTop: 24 }}>
          <h1
            className="t-h1"
            style={{ fontSize: 'clamp(30px, 4.5vw, 42px)', letterSpacing: '-0.02em', maxWidth: 900 }}
          >
            Was heute zählt,{' '}
            <em style={{ fontStyle: 'italic', fontWeight: 300, color: 'var(--ink-2)' }}>
              kommt zuerst
            </em>
            .
          </h1>
          <p
            style={{
              marginTop: 14,
              maxWidth: 640,
              fontSize: 15,
              lineHeight: 1.55,
              color: 'var(--ink-2)',
            }}
          >
            Deadlines, Approvals, Routinen. Heute oben, dann die nächsten sieben
            Tage, dann der Monat als Raster. Klick auf einen Monats-Tag für die
            Details.
          </p>
        </div>

        {/* Today block */}
        <section aria-labelledby="today-heading" style={{ marginTop: 40 }}>
          <h2 id="today-heading" style={sectionHeadingStyle}>
            Heute · {dayLabel(today)}
          </h2>
          {todayItems.length === 0 ? (
            <div style={quietEmptyStyle}>
              Nichts Fälliges heute. Wenn sich das richtig anfühlt, lehn dich zurück.
              Wenn nicht — frag den Chat, was untergeht.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {todayItems.map((t) => (
                <Ticket
                  key={t.id}
                  id={t.id}
                  status={t.status}
                  prio={t.prio}
                  title={t.title}
                  body={t.body}
                  segment={workspaceLabel(t.segmentId, wsLite)}
                  assignee={t.assignee}
                  due={t.due}
                />
              ))}
            </div>
          )}

          {firstToday ? (
            <TodayQuickAction
              ticketId={firstToday.id}
              ticketTitle={firstToday.title}
            />
          ) : null}
        </section>

        {/* Week view */}
        <section aria-labelledby="week-heading" style={{ marginTop: 56 }}>
          <h2 id="week-heading" style={sectionHeadingStyle}>
            Diese Woche · 7 Tage
          </h2>
          <div style={{ display: 'grid', gap: 18 }}>
            {dayKeys.slice(0, 7).map((k) => {
              const list = weekByDay.get(k) ?? [];
              const isToday = k === todayKeyStr;
              return (
                <div key={k}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 10,
                      marginBottom: 8,
                      color: isToday ? 'var(--a-now)' : 'var(--ink-2)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      letterSpacing: '0.02em',
                    }}
                  >
                    <span>{dayLabels[k]}</span>
                    <span style={{ color: 'var(--ink-3)' }}>·</span>
                    <span>{list.length} {list.length === 1 ? 'Termin' : 'Termine'}</span>
                    {isToday ? (
                      <span style={{ color: 'var(--a-now)', marginLeft: 4 }}>heute</span>
                    ) : null}
                  </div>
                  {list.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--ink-3)', paddingLeft: 2 }}>
                      frei
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {list.map((t) => (
                        <div key={t.id} style={weekRowStyle}>
                          <Pill variant={workspaceAccentVariant(t.segmentId, wsLite)}>
                            {workspaceLabel(t.segmentId, wsLite)}
                          </Pill>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, color: 'var(--ink)', letterSpacing: '-0.01em' }}>
                              {t.title}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                              {t.id}{t.prio ? ` · ${t.prio}` : ''}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Month grid */}
        <section aria-labelledby="month-heading" style={{ marginTop: 56 }}>
          <h2 id="month-heading" style={sectionHeadingStyle}>
            Nächste 30 Tage
          </h2>
          <MonthGrid
            entries={entries}
            dayKeys={dayKeys}
            dayLabels={dayLabels}
            dayWeekIndex={dayWeekIndex}
            workspaces={wsLite}
          />
        </section>
      </section>
    </main>
  );
}

function prioWeight(p?: string): number {
  if (!p) return 5;
  if (p.startsWith('P0')) return 0;
  if (p.startsWith('P1')) return 1;
  if (p.startsWith('P2')) return 2;
  if (p.startsWith('P3')) return 3;
  return 4;
}

const sectionHeadingStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink-3)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginBottom: 14,
  fontFamily: 'var(--font-mono)',
  fontWeight: 400,
};

const quietEmptyStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--ink-2)',
  padding: 20,
  borderRadius: 14,
  border: '0.5px dashed var(--line-2)',
  background: 'var(--sheet-2)',
  lineHeight: 1.55,
};

const weekRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 10,
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
};
