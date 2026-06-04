/**
 * Tests fuer Bug 3 — "/clear leert nicht persistent".
 * ----------------------------------------------------
 * 2026-05-03. Server schreibt einen `chat_truncated`-Event server-side
 * und liefert beim naechsten History-Load `cutoffMs` mit. `mergeServerWithLocal`
 * muss ALLE local-Items mit `ts <= cutoffMs` rauswerfen — auch
 * `chat-compacted`-Cards, sonst kommt nach einem /clear das alte Compact-
 * Summary wieder (User-Beschwerde).
 *
 * Plus: localStorage-Key `lazyos.chat.history.{workspaceId}` muss bei
 * `/clear` zusaetzlich geleert werden — slash-commands.ts macht das schon
 * (siehe `clearHistoryFor`-Helper). Test prueft Reload-Pfad: lokale Items
 * < cutoffMs werden verworfen, Server-Items leben (= leer nach /clear).
 *
 * Lauf:  pnpm exec vitest run lib/chat/__tests__/clear-persistence.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HistoryItem } from '../ChatShell';
import { clearHistoryFor, mergeServerWithLocal } from '../storage';

function mkItem(partial: Partial<HistoryItem> & { id: string; ts: string }): HistoryItem {
  return {
    role: 'assistant',
    content: '',
    ...partial,
  } as HistoryItem;
}

const HISTORY_KEY = 'lazyos.chat.history.ws-clear-test';

describe('mergeServerWithLocal mit cutoffMs', () => {
  it('verwirft ALLE lokalen Items mit ts <= cutoffMs (auch chat-compacted)', () => {
    const cutoff = Date.parse('2026-05-03T10:00:00Z');
    const local: HistoryItem[] = [
      // Vor Cutoff — alle muessen weg.
      mkItem({ id: 'old-user', ts: '2026-05-03T09:00:00Z', role: 'user' }),
      mkItem({ id: 'old-asst', ts: '2026-05-03T09:30:00Z', role: 'assistant' }),
      // chat-compacted VOR cutoff — muss AUCH weg (Bug-3-spezifisch).
      mkItem({
        id: 'old-compacted',
        ts: '2026-05-03T09:45:00Z',
        role: 'assistant',
        // surfaceKind ist optional — Type-Cast in mkItem-Helper.
        surfaceKind: 'chat-compacted' as HistoryItem['surfaceKind'],
        content: '<surface:chat-compacted>{"summary":"alt"}</surface:chat-compacted>',
      }),
      // Nach Cutoff — bleibt.
      mkItem({ id: 'new-user', ts: '2026-05-03T10:30:00Z', role: 'user' }),
    ];
    const server: HistoryItem[] = [];
    const merged = mergeServerWithLocal(server, local, cutoff);
    const ids = merged.map((i) => i.id);
    expect(ids).toEqual(['new-user']);
    expect(ids).not.toContain('old-compacted');
    expect(ids).not.toContain('old-user');
  });

  it('cutoffMs=0 ist no-op (alle lokalen Items bleiben)', () => {
    const local: HistoryItem[] = [
      mkItem({ id: 'a', ts: '2026-05-03T09:00:00Z' }),
      mkItem({ id: 'b', ts: '2026-05-03T10:00:00Z' }),
    ];
    const merged = mergeServerWithLocal([], local, 0);
    expect(merged.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('Reload-Simulation nach /clear: leere Server-Liste + cutoff > newest local → leere History', () => {
    const cutoff = Date.parse('2026-05-03T11:00:00Z');
    // localStorage simuliert noch den alten Cache (vor /clear).
    const local: HistoryItem[] = [
      mkItem({ id: 'cached-1', ts: '2026-05-03T09:00:00Z', role: 'user' }),
      mkItem({ id: 'cached-2', ts: '2026-05-03T10:00:00Z', role: 'assistant' }),
      // Auch ein altes chat-compacted im Cache.
      mkItem({
        id: 'cached-compacted',
        ts: '2026-05-03T10:30:00Z',
        role: 'assistant',
        surfaceKind: 'chat-compacted' as HistoryItem['surfaceKind'],
        content: '<surface:chat-compacted>{"summary":"alter snapshot"}</surface:chat-compacted>',
      }),
    ];
    const merged = mergeServerWithLocal([], local, cutoff);
    expect(merged).toEqual([]);
  });

  it('Optimistic-Echo NACH /clear: lokales Item mit ts > cutoff ueberlebt', () => {
    const cutoff = Date.parse('2026-05-03T10:00:00Z');
    const local: HistoryItem[] = [
      mkItem({ id: 'pre-clear', ts: '2026-05-03T09:00:00Z' }),
      // User schickt direkt nach /clear eine Message — Optimistic-Echo
      // entsteht lokal mit ts > cutoff, soll NICHT weggetrimmt werden.
      mkItem({ id: 'post-clear-optimistic', ts: '2026-05-03T10:30:00Z', role: 'user' }),
    ];
    const merged = mergeServerWithLocal([], local, cutoff);
    expect(merged.map((i) => i.id)).toEqual(['post-clear-optimistic']);
  });

  it('chat-compacted NACH cutoff (= post-/clear-/compact) ueberlebt', () => {
    const cutoff = Date.parse('2026-05-03T10:00:00Z');
    const local: HistoryItem[] = [
      mkItem({
        id: 'fresh-compacted',
        ts: '2026-05-03T11:00:00Z',
        surfaceKind: 'chat-compacted' as HistoryItem['surfaceKind'],
        content: '<surface:chat-compacted>{"summary":"frisch"}</surface:chat-compacted>',
      }),
    ];
    const merged = mergeServerWithLocal([], local, cutoff);
    expect(merged.map((i) => i.id)).toEqual(['fresh-compacted']);
  });

  it('Server-Items werden nicht durch cutoffMs gefiltert (Server hat selbst gefiltert)', () => {
    const cutoff = Date.parse('2026-05-03T10:00:00Z');
    // Server liefert Items VOR dem Cutoff — kann passieren wenn Backend-
    // Logik den Cutoff anders interpretiert. Wir vertrauen dem Server,
    // er hat seine Items bereits korrekt gefiltert.
    const server: HistoryItem[] = [
      mkItem({ id: 'srv-1', ts: '2026-05-03T09:30:00Z', role: 'assistant' }),
    ];
    const local: HistoryItem[] = [];
    const merged = mergeServerWithLocal(server, local, cutoff);
    expect(merged.map((i) => i.id)).toEqual(['srv-1']);
  });

  it('Items mit unparsbarem ts werden bei cutoffMs konservativ behalten', () => {
    const cutoff = Date.parse('2026-05-03T10:00:00Z');
    const local: HistoryItem[] = [
      mkItem({ id: 'broken-ts', ts: 'not-a-date' }),
    ];
    const merged = mergeServerWithLocal([], local, cutoff);
    expect(merged.map((i) => i.id)).toEqual(['broken-ts']);
  });
});

// ---------------------------------------------------------------------------
// localStorage-Cache-Reset durch clearHistoryFor
// ---------------------------------------------------------------------------

describe('clearHistoryFor + Reload-Pfad', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(HISTORY_KEY);
    }
  });

  afterEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(HISTORY_KEY);
    }
  });

  it('clearHistoryFor leert den localStorage-Key', () => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([{ id: 'cached', ts: '2026-05-03T10:00:00Z' }]),
    );
    expect(window.localStorage.getItem(HISTORY_KEY)).not.toBeNull();
    clearHistoryFor('ws-clear-test');
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
  });

  it('Reload nach /clear: cleared cache + leerer Server + cutoff = leere History', () => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    // 1. /clear hat den Key bereits geleert.
    clearHistoryFor('ws-clear-test');
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();
    // 2. Reload-Pfad simulieren: leerer localStorage + leerer Server + cutoff.
    const cutoff = Date.parse('2026-05-03T11:00:00Z');
    const merged = mergeServerWithLocal([], [], cutoff);
    expect(merged).toEqual([]);
  });

  it('Pathological: User klickt /clear, dann kommt VERZOEGERT noch eine alte Server-Bubble durch (z.B. SSE-Replay) — wird NICHT durch cutoff gefiltert (Server-Vertrauen), aber lokaler Cache bleibt sauber', () => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    clearHistoryFor('ws-clear-test');
    const cutoff = Date.parse('2026-05-03T10:00:00Z');
    const stragglerServer: HistoryItem[] = [
      mkItem({ id: 'late-server', ts: '2026-05-03T09:50:00Z', role: 'assistant' }),
    ];
    const merged = mergeServerWithLocal(stragglerServer, [], cutoff);
    // Server-Items werden nicht clientseitig gefiltert — der Server soll
    // selbst entscheiden was er ausliefert. Wenn er ein altes Event
    // schickt, vertrauen wir ihm (eventuelle Bug-Klasse: server-bug,
    // nicht client-bug).
    expect(merged.map((i) => i.id)).toEqual(['late-server']);
  });
});
