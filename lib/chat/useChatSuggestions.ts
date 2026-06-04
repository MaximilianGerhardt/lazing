'use client';

/**
 * useChatSuggestions — Inline-AutoSuggest für ChatComposer (mobile-first).
 *
 * Tippt der User typische Präfixe ("Ti", "Rou", "Ses", "Obs", Workspace-IDs),
 * liefert der Hook eine kleine Liste ChatSuggestions, die der Composer
 * als Dropdown ÜBER dem Input-Feld rendert — kein Cmd+K nötig.
 *
 * Design-Intent:
 *   - Trigger ab len >= 2
 *   - Max 6 Items (Mobile-Viewport)
 *   - Drei Kategorien: nav (Routen), act (Aktionen), ws (Workspace-Switch)
 *   - Keine Chat-Prompt-Suggestion — das ist der Default beim Absenden.
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
   * Sub-Plan B (2026-04-29) — wenn die Eingabe mit `/` beginnt, soll das
   * Composer-Feld auf den ausgewaehlten Slash-Command-Namen gesetzt werden
   * (statt der Suggestion zu folgen). Caller liefert den Setter mit; ohne
   * ihn fallen Slash-Suggestions auf einen no-op `onSelect` zurueck.
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

    // ---- Slash-Command-Branch ----
    // Eingabe beginnt mit `/` -> wir zeigen NUR Slash-Commands, kein nav/ws/
    // act-Mix. Filter laesst sich rein lexikalisch loesen: alles was mit dem
    // bisher getippten Praefix anfaengt. Min-length-Schwelle gilt hier
    // ausnahmsweise nicht — schon `/` allein soll die Liste oeffnen.
    // Slash-Branch: User tippt mit `/` -> wir zeigen NUR Slash-Commands
    // OHNE führenden Slash im Label (User-Wunsch 2026-05-03: "befehle wie
    // /clear oder /compact nicht mit / im command center"). onSelect
    // setzt den Composer auf das bare-word — `parseSlashCommand` akzeptiert
    // sowohl `clear` als auch `/clear` als Match.
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

    // Bare-word Slash-Suggestions (User-Wunsch 2026-05-03): wenn User
    // anfängt zu tippen ohne Slash, sollen Session-Commands trotzdem
    // findbar sein. Fuzzy-Match auf bare-name + description.
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

    // ---- Routen ----
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

    // ---- Workspaces (fuzzy auf id + label) ----
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
