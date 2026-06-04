'use client';

/**
 * SubchatPulse — proaktive Sub-Chat-Intelligenz im HAUPTCHAT
 * (Gathering-Intelligence in den Hauptchat holen, 2026-06-02).
 *
 * Der Hauptchat ist die zentrale Fläche und sitzt i.d.R. auf dem Org-Root.
 * Die Kundenchats (Sub-Chats) hängen an realen Kunden-Workspaces. Diese Karte
 * AGGREGIERT daher workspace-übergreifend (`GET /api/subchats/activity`): kommt
 * in IRGENDEINEM Kundenchat etwas Neues von extern an, taucht es hier — dezent,
 * oben im Feed, im gleichen Inline-Surface-Muster wie `PushAutoPrompt` — auf,
 * mit dem Kunden-Workspace als Kontext-Eyebrow. Das ist das Sicherheitsnetz:
 * der Operator muss die Kundenchats nicht aktiv im Blick behalten.
 *
 * - „Im Hauptchat aufgreifen" seedet den Composer mit einem fertigen Prompt
 *   (KI-Vorschlag-Stil wie in der Claude-Code-App); der Hauptchat arbeitet das
 *   Kunden-Anliegen mit dem bereits ingesteten RAG-Wissen aus.
 * - „Öffnen" springt in die interne Team-Sicht des jeweiligen Sub-Chats.
 * - „neu seit" wird client-seitig gegen eine globale localStorage-seen-Map
 *   entschieden (keine DB-Tabelle, voll reversibel). Dismiss markiert gesehen.
 *
 * Rendert NICHTS, solange keine neue externe Aktivität vorliegt — kein Chrome
 * im leeren Chat. Mobile-first, nur Design-Tokens, keine Hex-Werte.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useEventStream } from '@/lib/chat/useEventStream';
import { useWorkspaces } from '@/lib/nav/hooks';

interface ActivityItem {
  id: string;
  title: string;
  kind: 'external' | 'internal';
  workspaceId: string;
  workspaceLabel: string;
  lastMessage: {
    authorKind: 'internal' | 'external' | 'system';
    authorName: string | null;
    content: string;
    ts: number;
  } | null;
  lastExternalTs: number | null;
  externalCount: number;
  /**
   * Ungelesen-Zähler aus der Activity-API. HEUTE immer 0 über die Leitung:
   * die Route ruft `getSubchatActivity(ws)` ohne `viewerUserId` (route.ts:41),
   * daher liefert der Service `unreadCount: 0`. Sobald der Parent die 1-Zeile
   * `getSubchatActivity(ws, userId)` nachzieht, leuchtet das Badge automatisch.
   * Additiv + optional → safe to ship now.
   */
  unreadCount?: number;
}

const POLL_MS = 15_000;
const SEEN_KEY = 'lazyos.subchat.seen';
// MAIN.3: distinct from SEEN_KEY. Records, per subchatId, the `lastExternalTs`
// value for which a proactive-suggestion fetch was ALREADY issued — so a
// re-render/remount never re-fires the at-most-once-per-new-activity fetch.
// The seen-map governs surfacing/dismiss; this governs the suggestion fetch.
const PROMPTED_KEY = 'lazyos.subchat.suggested';

function readSeen(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function writeSeen(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function readPrompted(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(PROMPTED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}
function writePrompted(map: Record<string, number>): void {
  try {
    window.localStorage.setItem(PROMPTED_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

type SuggestionState = {
  state: 'loading' | 'ready' | 'none';
  text: string;
  // Server-pre-generierte Vorschlag-ID (PS-*) — getragen für den N8-Decision-
  // Audit + das Server-seitige Dismiss beim „Übernehmen". Bei client-seitigem
  // Fallback (keine Server-Row) bleibt es undefined.
  suggestionId?: string;
};

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std`;
  const d = Math.floor(h / 24);
  return `vor ${d} Tg`;
}

export function SubchatPulse({
  onPickUp,
}: {
  onPickUp: (prompt: string, target?: { workspaceId: string; organizationId?: string }) => void;
}): React.ReactElement | null {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [seen, setSeen] = useState<Record<string, number>>({});
  // MAIN.3: per-item proactive-suggestion state (loading/ready/none + text).
  const [suggestions, setSuggestions] = useState<Record<string, SuggestionState>>({});
  const aliveRef = useRef(true);

  // MAIN.1: resolve the customer workspace's organizationId from the singleton-
  // cached useWorkspaces() read (no extra network cost). The activity item does
  // NOT carry organizationId; resolving it client-side keeps the shared
  // activity route untouched and adds zero migrations.
  const { workspaces } = useWorkspaces();
  const resolveOrgId = useCallback(
    (wsId: string): string | undefined =>
      workspaces.find((w) => w.id === wsId)?.organizationId ?? undefined,
    [workspaces],
  );

  useEffect(() => {
    setSeen(readSeen());
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/subchats/activity', { cache: 'no-store' });
      if (!aliveRef.current) return;
      if (!res.ok) {
        setItems([]);
        return;
      }
      const data = (await res.json()) as { activity?: ActivityItem[] };
      if (aliveRef.current) setItems(Array.isArray(data.activity) ? data.activity : []);
    } catch {
      /* offline/abort — Karte bleibt wie sie ist */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    const iv = window.setInterval(() => void load(), POLL_MS);
    const onFocus = (): void => {
      setSeen(readSeen());
      void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      aliveRef.current = false;
      window.clearInterval(iv);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [load]);

  // Optional + additiv: cross-workspace Live-Subscription. KEIN workspaceId-
  // Filter (der Pulse aggregiert workspace-übergreifend). Bei einer neuen
  // EXTERNEN Sub-Chat-Nachricht ein debounced load() → der Pulse ist nahezu
  // sofort statt ≤15s. Der 15s-Poll bleibt der Boden. Wirft nie, ändert den
  // Render-Kontrakt (`onPickUp`) nicht.
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEventStream({
    enabled: true,
    onEvent: (ev) => {
      try {
        if (ev.type !== 'subchat_message') return;
        const p = ev.payload as { authorKind?: string } | undefined;
        if (p?.authorKind !== 'external') return;
        if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
        liveTimerRef.current = setTimeout(() => {
          liveTimerRef.current = null;
          void load();
        }, 250);
      } catch {
        /* nie werfen */
      }
    },
  });

  const surfaced = useMemo(
    () =>
      items.filter(
        (it) => it.lastExternalTs !== null && it.lastExternalTs > (seen[it.id] ?? 0),
      ),
    [items, seen],
  );

  const markSeen = useCallback((it: ActivityItem) => {
    setSeen((prev) => {
      const next = { ...prev, [it.id]: it.lastExternalTs ?? Date.now() };
      writeSeen(next);
      return next;
    });
  }, []);

  const dismissAll = useCallback(() => {
    setSeen((prev) => {
      const next = { ...prev };
      for (const it of surfaced) next[it.id] = it.lastExternalTs ?? Date.now();
      writeSeen(next);
      return next;
    });
  }, [surfaced]);

  const pickUp = useCallback(
    (it: ActivityItem) => {
      const who = it.lastMessage?.authorName?.trim() || 'Der Kunde';
      const msg = it.lastMessage?.content?.trim() ?? '';
      const prompt =
        `Im Kundenchat „${it.title}" (Workspace: ${it.workspaceLabel}) schrieb ${who}: „${msg}"\n\n` +
        `Was bedeutet das für die Arbeit an diesem Workspace? Berücksichtige mögliche ` +
        `technische Komplikationen und schlag konkrete nächste Schritte vor.`;
      // MAIN.1: re-scope the main chat into the customer's REAL workspace so the
      // next operator-tap-to-send runs with that workspace's RAG scope (N2).
      onPickUp(prompt, { workspaceId: it.workspaceId, organizationId: resolveOrgId(it.workspaceId) });
      markSeen(it);
    },
    [onPickUp, markSeen, resolveOrgId],
  );

  // MAIN.3: bounded proactive-suggestion fetch — at most ONE per new-external-
  // activity per item, never a tight loop. Keyed on `surfaced`: for each item
  // where (a) lastExternalTs > prompted[id] AND (b) suggestions[id] is unset,
  // mark it prompted in localStorage BEFORE the await (so a re-render/remount
  // never re-fires), set loading, POST the SLICE-API endpoint, then ready/none.
  useEffect(() => {
    if (surfaced.length === 0) return;
    const prompted = readPrompted();
    const toFetch = surfaced.filter(
      (it) =>
        it.lastExternalTs !== null &&
        it.lastExternalTs > (prompted[it.id] ?? 0) &&
        suggestions[it.id] === undefined,
    );
    if (toFetch.length === 0) return;

    // Write the prompted-watermark for the whole batch BEFORE any await.
    const nextPrompted = { ...prompted };
    for (const it of toFetch) nextPrompted[it.id] = it.lastExternalTs ?? 0;
    writePrompted(nextPrompted);

    setSuggestions((prev) => {
      const next = { ...prev };
      for (const it of toFetch) next[it.id] = { state: 'loading', text: '' };
      return next;
    });

    for (const it of toFetch) {
      void (async () => {
        try {
          // 1) Server-pre-generierten Vorschlag lesen (kein Engine-Call).
          let text = '';
          let suggestionId: string | undefined;
          try {
            const sres = await fetch(
              `/api/subchats/${encodeURIComponent(it.id)}/suggestion`,
              { cache: 'no-store', credentials: 'same-origin' },
            );
            if (sres.ok) {
              const sdata = (await sres.json()) as { suggestion?: unknown; suggestionId?: unknown };
              if (typeof sdata.suggestion === 'string') text = sdata.suggestion.trim();
              if (typeof sdata.suggestionId === 'string') suggestionId = sdata.suggestionId;
            }
          } catch {
            /* fall through to client fallback */
          }
          // 2) Fallback: client-seitige Generierung (bestehendes Verhalten) NUR wenn
          //    es keinen Server-Vorschlag gibt. Erhält die Abwärtskompatibilität.
          if (!text) {
            const res = await fetch('/api/chat/proactive/subchat-suggestion', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ subchatId: it.id, workspaceId: it.workspaceId }),
              cache: 'no-store',
              credentials: 'same-origin',
            });
            if (res.ok) {
              const data = (await res.json()) as { suggestion?: unknown };
              if (typeof data.suggestion === 'string') text = data.suggestion.trim();
            }
          }
          if (!aliveRef.current) return;
          setSuggestions((prev) => ({
            ...prev,
            [it.id]: text ? { state: 'ready', text, suggestionId } : { state: 'none', text: '' },
          }));
        } catch {
          if (!aliveRef.current) return;
          setSuggestions((prev) => ({ ...prev, [it.id]: { state: 'none', text: '' } }));
        }
      })();
    }
  }, [surfaced, suggestions]);

  // MAIN.3: „Verwerfen" — fold the suggestion away for this lastExternalTs.
  // The prompted-watermark is already written, so it does not reappear.
  const dismissSuggestion = useCallback((it: ActivityItem) => {
    setSuggestions((prev) => ({ ...prev, [it.id]: { state: 'none', text: '' } }));
    markSeen(it);
  }, [markSeen]);

  if (surfaced.length === 0) return null;

  return (
    <section style={wrap} aria-label="Neues aus deinen Kundenchats">
      <div style={head}>
        <span style={dot} aria-hidden="true" />
        <span style={headLabel}>
          Aus deinen Kundenchats
          {surfaced.length > 1 ? ` · ${surfaced.length}` : ''}
        </span>
        <button type="button" onClick={dismissAll} style={dismissBtn} aria-label="Ausblenden">
          ×
        </button>
      </div>

      <ul style={list}>
        {surfaced.slice(0, 4).map((it) => {
          const who = it.lastMessage?.authorName?.trim() || 'Kunde';
          const ts = it.lastExternalTs ?? it.lastMessage?.ts ?? Date.now();
          return (
            <li key={it.id} style={row}>
              <div style={eyebrow}>{it.workspaceLabel}</div>
              <div style={rowHead}>
                <span style={rowTitle}>{it.title}</span>
                {typeof it.unreadCount === 'number' && it.unreadCount > 0 ? (
                  <span style={unreadBadge} aria-label={`${it.unreadCount} ungelesen`}>
                    {it.unreadCount > 99 ? '99+' : it.unreadCount}
                  </span>
                ) : null}
                <span style={rowTime}>{relTime(ts)}</span>
              </div>
              <div style={preview}>
                <span style={previewWho}>{who}:</span> {it.lastMessage?.content ?? ''}
              </div>
              <div style={actions}>
                <button type="button" onClick={() => pickUp(it)} style={primaryAction}>
                  Im Hauptchat aufgreifen
                </button>
                <a
                  href={`/workspaces/${encodeURIComponent(it.workspaceId)}/subchats/${encodeURIComponent(it.id)}`}
                  onClick={() => markSeen(it)}
                  style={secondaryAction}
                >
                  Öffnen
                </a>
              </div>
              {/* MAIN.3: proaktiver Vorschlag (operator-facing, RAG-gestützt,
                  workspace-isoliert). Rendert NUR bei ready+non-empty; sonst
                  nichts (Engine down / nichts Neues). „Übernehmen" re-scopet
                  + seedet den Composer (MAIN.1) — NIE Auto-Send. */}
              {suggestions[it.id]?.state === 'ready' && suggestions[it.id].text ? (
                <div style={suggestWrap}>
                  <div style={eyebrow}>Vorschlag</div>
                  <div style={suggestText}>{suggestions[it.id].text}</div>
                  <div style={actions}>
                    <button
                      type="button"
                      onClick={() => {
                        const s = suggestions[it.id];
                        const text = s?.text ?? '';
                        // 1) Composer seeden (re-scope auf Kunden-Workspace, N2) — NIE Auto-Send.
                        onPickUp(text, {
                          workspaceId: it.workspaceId,
                          organizationId: resolveOrgId(it.workspaceId),
                        });
                        // 2) N8 Decision-Audit (append-only) + Server-Vorschlag dismissen.
                        //    Fire-and-forget, best-effort — UI nie blockieren.
                        void fetch('/api/proactive/decision', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            subchatId: it.id,
                            suggestionId: s?.suggestionId,
                            suggestion: text,
                          }),
                          cache: 'no-store',
                          credentials: 'same-origin',
                        }).catch(() => undefined);
                        // 3) lokal verbergen.
                        setSuggestions((prev) => ({ ...prev, [it.id]: { state: 'none', text: '' } }));
                        markSeen(it);
                      }}
                      style={primaryAction}
                    >
                      Übernehmen
                    </button>
                    <a
                      href={`/workspaces/${encodeURIComponent(it.workspaceId)}/subchats/${encodeURIComponent(it.id)}`}
                      onClick={() => markSeen(it)}
                      style={secondaryAction}
                    >
                      Öffnen
                    </a>
                    <button
                      type="button"
                      onClick={() => dismissSuggestion(it)}
                      style={secondaryAction}
                    >
                      Verwerfen
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const wrap: CSSProperties = {
  width: '100%',
  maxWidth: 680,
  margin: '4px auto 14px',
  background: 'color-mix(in oklab, var(--a-now) 7%, var(--sheet-2, #0E0E0F))',
  border: '0.5px solid var(--line-2)',
  borderRadius: 16,
  overflow: 'hidden',
};
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderBottom: '0.5px solid var(--line-2)',
};
const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 999,
  background: 'var(--a-now, #2E6FF2)',
  flexShrink: 0,
  boxShadow: '0 0 0 3px color-mix(in oklab, var(--a-now) 22%, transparent)',
};
const headLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '0.01em',
  color: 'var(--ink-2)',
  textTransform: 'uppercase',
};
const dismissBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-3)',
  fontSize: 20,
  lineHeight: 1,
  cursor: 'pointer',
  flexShrink: 0,
  // a11y: 44px Tap-Target (Glyph bleibt visuell klein, Hit-Area wächst).
  minWidth: 44,
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  marginRight: -10,
};
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const row: CSSProperties = {
  padding: '11px 12px',
  borderTop: '0.5px solid color-mix(in oklab, var(--line-2) 60%, transparent)',
};
const eyebrow: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  fontFamily: 'var(--font-mono)',
  marginBottom: 3,
};
const rowHead: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8 };
const rowTitle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const unreadBadge: CSSProperties = {
  flexShrink: 0,
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  background: 'var(--a-now, #2E6FF2)',
  color: 'var(--on-accent)',
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
};
const rowTime: CSSProperties = { flexShrink: 0, fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' };
const preview: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.45,
  color: 'var(--ink-2)',
  margin: '4px 0 9px',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};
const previewWho: CSSProperties = { color: 'var(--ink)', fontWeight: 550 };
const actions: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const primaryAction: CSSProperties = {
  background: 'var(--a-now, #2E6FF2)',
  color: 'var(--on-accent)',
  border: 'none',
  borderRadius: 999,
  padding: '7px 14px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  // a11y: 44px Tap-Target.
  minHeight: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const secondaryAction: CSSProperties = {
  background: 'var(--sheet-3, #141416)',
  color: 'var(--ink)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 999,
  padding: '7px 14px',
  fontSize: 12.5,
  fontWeight: 550,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  // a11y: 44px Tap-Target.
  minHeight: 44,
};
// MAIN.3: proaktiver Vorschlag-Block — gleiche Token wie der Rest der Karte.
const suggestWrap: CSSProperties = {
  marginTop: 10,
  padding: '10px 11px',
  background: 'var(--sheet-3, #141416)',
  border: '0.5px solid var(--line-2)',
  borderRadius: 12,
};
const suggestText: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--ink-2)',
  margin: '5px 0 9px',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  whiteSpace: 'pre-wrap',
};

export default SubchatPulse;
