'use client';

/**
 * useChatSuggestions — inline auto-suggest for ChatComposer (mobile-first).
 *
 * When the user types typical prefixes ("Ti", "Rou", "Ses", "Obs", workspace IDs),
 * the hook returns a small list of ChatSuggestions that the composer
 * renders as a dropdown ABOVE the input field — no Cmd+K needed.
 *
 * Design intent:
 *   - Triggers from len >= 2
 *   - Max 6 items (mobile viewport)
 *   - Three categories: nav (routes), act (actions), ws (workspace switch)
 *   - No chat-prompt suggestion — that is the default on send.
 */

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';

import { useCurrentWorkspace, useSetWorkspace, useWorkspaces } from '@/lib/nav/hooks';
import { REGISTRY as SLASH_REGISTRY } from './slash-commands';

export type ChatSuggestionKind = 'nav' | 'act' | 'ws' | 'slash';

export interface ChatSuggestion {
  id: string;
  kind: ChatSuggestionKind;
  label: string;
  detail?: string;
  /** Match-score (higher = better). Used for sort. */
  score: number;
  onSelect: () => void;
}

function fuzzy(query: string, hay: string): number {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const h = hay.toLowerCase();
  if (h.startsWith(q)) return 15 + (q.length / h.length) * 5;
  if (h.includes(q)) return 10 + (q.length / h.length) * 3;
  // char-fuzzy
  let qi = 0;
  for (let i = 0; i < h.length && qi < q.length; i++) {
    if (h[i] === q[qi]) qi++;
  }
  return qi === q.length ? (qi / h.length) * 2 : 0;
}

interface Options {
  /** Turn suggestions off (e.g. while STT is listening). */
  enabled?: boolean;
  /** Min-length before suggestions appear. Default 2. */
  minLength?: number;
  /**
   * Sub-Plan B (2026-04-29) — when the input starts with `/`, the
   * composer field should be set to the chosen slash-command name
   * (instead of following the suggestion). The caller provides the setter; without
   * it, slash suggestions fall back to a no-op `onSelect`.
   */
  setInput?: (value: string) => void;
}

export function useChatSuggestions(
  query: string,
  opts: Options = {},
): ChatSuggestion[] {
  const { enabled = true, minLength = 2, setInput } = opts;
  const router = useRouter();
  const { workspaces } = useWorkspaces();
  const currentWs = useCurrentWorkspace();
  const setWorkspace = useSetWorkspace();

  return useMemo<ChatSuggestion[]>(() => {
    const q = query.trim();
    if (!enabled) return [];

    // ---- Slash-command branch ----
    // Input starts with `/` -> we show ONLY slash commands, no nav/ws/
    // act mix. The filter can be solved purely lexically: everything that starts
    // with the prefix typed so far. The min-length threshold does
    // exceptionally not apply here — even `/` alone should open the list.
    // Slash branch: the user types with `/` -> we show ONLY slash commands
    // WITHOUT a leading slash in the label (user request 2026-05-03: "befehle wie
    // /clear oder /compact nicht mit / im command center"). onSelect
    // sets the composer to the bare word — `parseSlashCommand` accepts
    // both `clear` and `/clear` as a match.
    if (q.startsWith('/')) {
      const lowerNoSlash = q.slice(1).toLowerCase();
      const matches: ChatSuggestion[] = [];
      for (const cmd of SLASH_REGISTRY.values()) {
        const bare = cmd.name.replace(/^\//, '');
        if (bare.toLowerCase().startsWith(lowerNoSlash)) {
          matches.push({
            id: `slash-${bare}`,
            kind: 'slash',
            label: bare,
            detail: cmd.description,
            score: 100,
            onSelect: () => {
              if (setInput) setInput(`${bare} `);
            },
          });
        }
      }
      matches.sort((a, b) => a.label.localeCompare(b.label));
      return matches.slice(0, 8);
    }

    if (q.length < minLength) return [];

    const out: ChatSuggestion[] = [];

    // Bare-word slash suggestions (user request 2026-05-03): when the user
    // starts typing without a slash, session commands should still
    // be findable. Fuzzy match on bare-name + description.
    for (const cmd of SLASH_REGISTRY.values()) {
      const bare = cmd.name.replace(/^\//, '');
      const sc = fuzzy(q, bare + ' ' + cmd.description);
      if (sc >= 2) {
        out.push({
          id: `slash-${bare}`,
          kind: 'slash',
          label: bare,
          detail: cmd.description,
          score: sc + 1,
          onSelect: () => {
            if (setInput) setInput(`${bare} `);
          },
        });
      }
    }

    // ---- Routes ----
    const navs: Array<{ label: string; detail: string; href: string; kind: ChatSuggestionKind }> = [
      { label: 'Tickets zeigen', detail: 'alle offenen Aufgaben', href: '/tickets', kind: 'nav' },
      { label: 'Ticket erstellen', detail: 'neue Aufgabe anlegen', href: '/tickets/new', kind: 'act' },
      { label: 'Sessions', detail: 'Claude-Code-Sessions fortsetzen', href: '/sessions', kind: 'nav' },
      { label: 'Routines', detail: 'Auto-Runs & Cron', href: '/routines', kind: 'nav' },
      { label: 'Observatory', detail: 'Heartbeat aller Projekte', href: '/observatory', kind: 'nav' },
      { label: 'Workstreams', detail: 'Multi-Agent-Container', href: '/workstreams', kind: 'nav' },
      { label: 'Kanban', detail: 'Workstreams nach Status', href: '/workstreams?view=kanban', kind: 'nav' },
      { label: 'Calendar', detail: 'Fälligkeiten', href: '/calendar', kind: 'nav' },
      { label: 'Design', detail: 'Komponenten-Library', href: '/design', kind: 'nav' },
    ];
    for (const n of navs) {
      const sc = fuzzy(q, n.label + ' ' + n.detail);
      if (sc >= 2) {
        out.push({
          id: `nav-${n.href}`,
          kind: n.kind,
          label: n.label,
          detail: n.detail,
          score: sc,
          onSelect: () => router.push(n.href),
        });
      }
    }

    // ---- Workspaces (fuzzy on id + label) ----
    for (const w of workspaces) {
      const sc = fuzzy(q, w.id + ' ' + w.label);
      if (sc >= 3) {
        out.push({
          id: `ws-${w.id}`,
          kind: 'ws',
          label: `Workspace: ${w.label}`,
          detail:
            w.id === currentWs.id
              ? 'aktiv — kein Wechsel'
              : `wechseln zu ${w.id}`,
          score: sc + 2,
          onSelect: () => {
            if (w.id !== currentWs.id) setWorkspace(w.id);
          },
        });
      }
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 6);
  }, [
    query,
    enabled,
    minLength,
    workspaces,
    currentWs.id,
    setWorkspace,
    router,
    setInput,
  ]);
}
