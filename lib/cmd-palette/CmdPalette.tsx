'use client';

/**
 * Global Cmd+K palette — Spotlight-style for lazyOS.
 *
 * Automatic detection instead of a `/` prefix:
 *   - the user types "ticket x" → recognized as a ticket action
 *   - "demo-client" → workspace switch
 *   - "rout" → routines
 *   - "heartbeat"/"status" → observatory
 *   - free text → starts a chat in the active workspace
 *
 * Shortcut: Cmd+K / Ctrl+K opens, Esc closes.
 * Uses CmdBar + CmdSuggest from /lib/ui/cmd (design library).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { CmdBar, CmdSuggest, type CmdSuggestion } from '@/lib/ui/cmd';
import { useCurrentWorkspace, useSetWorkspace, useWorkspaces } from '@/lib/nav/hooks';

interface PaletteItem {
  id: string;
  label: string;
  detail: string;
  kind: CmdSuggestion['kind'];
  score: number;
  action: () => void;
}

function fuzzyScore(query: string, haystack: string): number {
  if (query.length === 0) return 1;
  const q = query.toLowerCase();
  const h = haystack.toLowerCase();
  if (h.includes(q)) return 10 + (q.length / h.length) * 5;
  // per-char fuzzy: consume q through h
  let qi = 0;
  for (let i = 0; i < h.length && qi < q.length; i++) {
    if (h[i] === q[qi]) qi++;
  }
  return qi === q.length ? (qi / h.length) * 3 : 0;
}

export function CmdPalette(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const router = useRouter();
  const { workspaces } = useWorkspaces();
  const currentWs = useCurrentWorkspace();
  const setWorkspace = useSetWorkspace();
  const inputIdRef = useRef(`cmd-${Math.random().toString(36).slice(2)}`);

  // Open via Cmd+K / Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Close on navigation
  const closeAndNav = useCallback(
    (url: string) => {
      setOpen(false);
      setQuery('');
      router.push(url);
    },
    [router],
  );

  // Build the candidate-list based on query (auto-detection)
  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const out: PaletteItem[] = [];

    // Navigation shortcuts (immer da)
    // Cmd+K = einziges Power-User-Superset (UI/UX-Neuausrichtung 2026-06-03):
    // covers EVERY nav target so menu/drawer/bar never drift apart again.
    const navs: Array<{ label: string; detail: string; href: string; kind: CmdSuggestion['kind'] }> = [
      { label: 'Chat', detail: 'zurück zum Dialog', href: '/', kind: 'nav' },
      { label: 'Decisions', detail: 'Decision-Log', href: '/decisions', kind: 'nav' },
      { label: 'Inbox', detail: 'Eingang & Benachrichtigungen', href: '/inbox', kind: 'nav' },
      { label: 'Sessions', detail: 'Claude-Code Sessions fortsetzen', href: '/sessions', kind: 'nav' },
      { label: 'Tickets', detail: 'offene Aufgaben', href: '/tickets', kind: 'nav' },
      { label: 'Neues Ticket', detail: 'Aufgabe anlegen', href: '/tickets/new', kind: 'act' },
      { label: 'Workstreams', detail: 'Multi-Agent-Container', href: '/workstreams', kind: 'nav' },
      { label: 'Kanban-Board', detail: 'Workstreams nach Status', href: '/workstreams?view=kanban', kind: 'nav' },
      { label: 'Routines', detail: 'Auto-Runs & Cron', href: '/routines', kind: 'nav' },
      { label: 'Observatory', detail: 'Heartbeat aller Projekte', href: '/observatory', kind: 'nav' },
      { label: 'Kalender', detail: 'Fälligkeiten', href: '/calendar', kind: 'nav' },
      { label: 'Einstellungen', detail: 'Engines · Skills · Push · Auto-Mode', href: '/settings', kind: 'nav' },
    ];
    // Design-Library = Dev-Showcase (Fixtures) → nur in Dev sichtbar.
    if (process.env.NODE_ENV === 'development') {
      navs.push({ label: 'Design', detail: 'Komponenten-Library (dev)', href: '/design', kind: 'doc' });
    }
    for (const n of navs) {
      const sc = fuzzyScore(q, n.label + ' ' + n.detail);
      if (sc > 0 || q.length === 0) {
        out.push({
          id: `nav-${n.href}`,
          label: n.label,
          detail: n.detail,
          kind: n.kind,
          score: sc === 0 ? 0.5 : sc,
          action: () => closeAndNav(n.href),
        });
      }
    }

    // Workspace-Switch (fuzzy-match)
    for (const w of workspaces) {
      const sc = fuzzyScore(q, w.id + ' ' + w.label);
      if (sc >= 2) {
        out.push({
          id: `ws-${w.id}`,
          label: `→ Workspace: ${w.label}`,
          detail: `Akzent ${w.organization?.name ?? w.accent}${w.id === currentWs.id ? ' · aktiv' : ''}`,
          kind: 'nav',
          score: sc + 2, // workspaces prominent
          action: () => {
            setWorkspace(w.id);
            setOpen(false);
            setQuery('');
          },
        });
      }
    }

    // Free text → chat prompt (if the query is not trivial)
    if (q.length >= 4 && !q.match(/^(tick|rout|heart|obs|sess|chat|lane|cal|des)/i)) {
      out.push({
        id: 'chat-prompt',
        label: `„${q}"`,
        detail: `Als Prompt im Chat senden (${currentWs.label})`,
        kind: 'act',
        score: 9,
        action: () => {
          // Sende via URL-param oder localStorage-signal
          try {
            window.localStorage.setItem('lazyos.cmd.prefill', q);
          } catch {
            /* ignore */
          }
          closeAndNav('/');
        },
      });
    }

    // Sort
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 10);
  }, [query, workspaces, currentWs, setWorkspace, closeAndNav]);

  // Reset active-idx when list shrinks
  useEffect(() => {
    if (activeIdx >= items.length) setActiveIdx(Math.max(0, items.length - 1));
  }, [items.length, activeIdx]);

  const suggestions = useMemo<CmdSuggestion[]>(
    () =>
      items.map((i) => ({
        id: i.id,
        kind: i.kind,
        label: i.label,
        detail: i.detail,
        shortcut: '↵',
        onSelect: i.action,
      })),
    [items],
  );

  if (!open) return null;

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      style={backdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div style={paletteStyle} onClick={(e) => e.stopPropagation()}>
        <div onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => Math.min(items.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = items[activeIdx];
            if (pick) pick.action();
          }
        }}>
          <CmdBar
            value={query}
            onChange={setQuery}
            placeholder="Tippe los — Befehle, Workspaces, oder frag Claude …"
            contextLabel={currentWs.label}
            onSubmit={() => {
              const pick = items[activeIdx];
              if (pick) pick.action();
            }}
          />
        </div>
        {items.length > 0 ? (
          <div style={{ marginTop: 10 }} role="list">
            <CmdSuggest
              suggestions={suggestions}
              activeIndex={activeIdx}
              listboxId={inputIdRef.current}
            />
          </div>
        ) : (
          <div style={emptyStyle}>
            keine Treffer — tippe 4+ Zeichen, um Claude zu fragen
          </div>
        )}
        <div style={footHintStyle}>
          ↑↓ navigieren · ↵ auswählen · esc schließen · Cmd-K Palette
        </div>
      </div>
    </div>
  );
}

// ---- styles ----
const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'color-mix(in oklab, var(--sheet) 70%, transparent)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  zIndex: 90,
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  paddingTop: 'clamp(60px, 12vh, 160px)',
};

const paletteStyle: React.CSSProperties = {
  width: 'min(640px, calc(100vw - 32px))',
  padding: 20,
  borderRadius: 18,
  background: 'color-mix(in oklab, var(--sheet-2) 95%, transparent)',
  border: '0.5px solid var(--line-2)',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
};

const emptyStyle: React.CSSProperties = {
  marginTop: 18,
  padding: 18,
  textAlign: 'center',
  color: 'var(--ink-3)',
  fontSize: 13,
  fontFamily: 'var(--font-mono)',
};

const footHintStyle: React.CSSProperties = {
  marginTop: 14,
  textAlign: 'center',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--ink-3)',
  opacity: 0.6,
  letterSpacing: '0.04em',
};
