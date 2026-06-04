/**
 * Tests fuer `computeTypingIndicator` — Single-Source-of-Truth-Hook fuer
 * den "Agent arbeitet"-Indikator (Welle 1, 2026-05-03).
 *
 * Pure-Funktion → keine React-Mounts noetig. Wir testen `compute…` direkt.
 *
 * Lauf: `pnpm exec vitest run lib/chat/__tests__/use-typing-indicator.test.ts`
 */

import { describe, expect, it } from 'vitest';

import {
  computeTypingIndicator,
  toolPhaseLabel,
  type UseTypingIndicatorArgs,
} from '../useTypingIndicator';

const BASE: UseTypingIndicatorArgs = {
  workstreamId: undefined,
  isStreaming: false,
  isMockPending: false,
  serverStreamPending: false,
  agentTurn: null,
  agentStatus: 'idle',
};

describe('computeTypingIndicator', () => {
  it('connecting: agentStatus=connecting + leerer Turn → phase=connecting', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: true,
      agentStatus: 'connecting',
      agentTurn: { text: '', tools: [] },
    });
    expect(out.kind).toBe('streaming');
    expect(out.phase).toBe('connecting');
    expect(out.label).toBe('Verbindet …');
  });

  it('reading: streaming, kein Text, kein running-tool → phase=reading', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: true,
      agentStatus: 'streaming',
      agentTurn: { text: '', tools: [] },
    });
    expect(out.kind).toBe('streaming');
    expect(out.phase).toBe('reading');
    expect(out.label).toBe('Liest deine Frage …');
  });

  it('tool-running: leerer Text + letztes Tool=running → phase=tool', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: true,
      agentStatus: 'streaming',
      agentTurn: {
        text: '',
        tools: [
          { name: 'Read', status: 'done', inputPreview: 'foo.ts' },
          { name: 'Bash', status: 'running', inputPreview: 'pnpm test' },
        ],
      },
    });
    expect(out.kind).toBe('streaming');
    expect(out.phase).toBe('tool');
    expect(out.toolName).toBe('Bash');
    expect(out.label).toBe('Führt aus: pnpm test …');
  });

  it('writing: Text vorhanden → phase=writing, ueberschreibt tool', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: true,
      agentStatus: 'streaming',
      agentTurn: {
        text: 'Hello world',
        tools: [{ name: 'Bash', status: 'running' }],
      },
    });
    expect(out.kind).toBe('streaming');
    expect(out.phase).toBe('writing');
    expect(out.label).toBe('Schreibt …');
  });

  it('mock-pending: kein Stream + isMockPending → kind=pending', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: false,
      isMockPending: true,
    });
    expect(out.kind).toBe('pending');
    expect(out.label).toBe('Liest deine Frage …');
  });

  it('server-stream-pending wirkt wie mock-pending', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: false,
      serverStreamPending: true,
    });
    expect(out.kind).toBe('pending');
  });

  it('streaming hat Vorrang vor isMockPending (User-tippt-doppelt-Race)', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: true,
      isMockPending: true,
      agentStatus: 'streaming',
      agentTurn: { text: 'partial', tools: [] },
    });
    expect(out.kind).toBe('streaming');
    expect(out.phase).toBe('writing');
  });

  it('none: alles idle → kind=none, leerer Label', () => {
    const out = computeTypingIndicator({ ...BASE });
    expect(out.kind).toBe('none');
    expect(out.label).toBe('');
    expect(out.phase).toBeUndefined();
  });

  it('workstreamId wird durchgereicht (fuer InlineWorkerStatus-Filter)', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: true,
      agentStatus: 'streaming',
      agentTurn: { text: '', tools: [] },
      workstreamId: 'ws_abc',
    });
    expect(out.workstreamId).toBe('ws_abc');
  });

  it('done-tools werden NICHT als running interpretiert', () => {
    const out = computeTypingIndicator({
      ...BASE,
      isStreaming: true,
      agentStatus: 'streaming',
      agentTurn: {
        text: '',
        tools: [
          { name: 'Read', status: 'done' },
          { name: 'Bash', status: 'done' },
        ],
      },
    });
    expect(out.phase).toBe('reading');
  });
});

describe('toolPhaseLabel', () => {
  it('mappt Tool-Namen auf User-Sprache', () => {
    expect(toolPhaseLabel('Read', 'foo.ts')).toBe('Liest foo.ts …');
    expect(toolPhaseLabel('Read', '')).toBe('Liest Datei …');
    expect(toolPhaseLabel('Bash', 'pnpm test')).toBe('Führt aus: pnpm test …');
    expect(toolPhaseLabel('WebSearch', 'lazyos')).toBe('Recherchiert im Web …');
    expect(toolPhaseLabel('UnknownTool', '')).toBe('UnknownTool …');
  });

  it('truncated Preview bei sehr langem Input', () => {
    const long = 'a'.repeat(80);
    const out = toolPhaseLabel('Bash', long);
    expect(out.length).toBeLessThan(80);
    expect(out).toContain('…');
  });
});
