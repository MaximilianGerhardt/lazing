/**
 * Tests fuer lib/chat/slash-commands.ts
 * --------------------------------------
 * Sub-Plan B (2026-04-29). Pure-Function-Coverage:
 *
 *   - parseSlashCommand          (case-handling, unknown, non-slash)
 *   - trimByWorkstream           (Coord-Kollaps + free-message-cap)
 *   - /clear handler             (setHistory(empty) + clearHistoryFor)
 *   - /compact handler           (Trim + Server-Snapshot-Roundtrip)
 *   - /help handler              (Toast mit alphabetischer Liste)
 *
 * Lauf:  pnpm exec vitest run lib/chat/__tests__/slash-commands.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import type { HistoryItem } from '../ChatShell';
import {
  REGISTRY,
  parseSlashCommand,
  extractSlashArgs,
  trimByWorkstream,
  handleFlowComposeResult,
  correlateQuickChoice,
  type SlashContext,
  type SystemItem,
  type FlowStyleChoiceRequest,
  type FlowStyleSession,
} from '../slash-commands';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkItem(partial: Partial<HistoryItem> & { id: string; ts: string }): HistoryItem {
  return {
    role: 'assistant',
    content: '',
    ...partial,
  } as HistoryItem;
}

function mkCtx(overrides: Partial<SlashContext> = {}): {
  ctx: SlashContext;
  history: HistoryItem[];
  toasts: SystemItem[];
  setHistorySpy: ReturnType<typeof vi.fn>;
  fetchSpy: ReturnType<typeof vi.fn>;
} {
  let history: HistoryItem[] = overrides.history ?? [];
  const toasts: SystemItem[] = [];
  const setHistorySpy = vi.fn((updater: HistoryItem[] | ((h: HistoryItem[]) => HistoryItem[])) => {
    history = typeof updater === 'function' ? updater(history) : updater;
  });
  const fetchSpy = vi.fn(async () => {
    return new Response(JSON.stringify({ summary: 'ok', planPath: '/tmp/p' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const ctx: SlashContext = {
    workspaceId: overrides.workspaceId ?? 'ws-test',
    history,
    setHistory: setHistorySpy as unknown as SlashContext['setHistory'],
    pushSystemToast: (item: SystemItem) => toasts.push(item),
    fetch: (overrides.fetch ?? (fetchSpy as unknown as typeof fetch)) as typeof fetch,
  };
  return { ctx, history, toasts, setHistorySpy, fetchSpy };
}

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

describe('parseSlashCommand', () => {
  it('matches /clear case-insensitively', () => {
    expect(parseSlashCommand('/clear')?.name).toBe('/clear');
    expect(parseSlashCommand('/CLEAR')?.name).toBe('/clear');
    expect(parseSlashCommand('/Clear')?.name).toBe('/clear');
  });

  it('ignores trailing args but still matches the command', () => {
    const cmd = parseSlashCommand('/clear extra junk here');
    expect(cmd?.name).toBe('/clear');
  });

  it('returns null for unknown commands', () => {
    expect(parseSlashCommand('/unknown')).toBeNull();
    expect(parseSlashCommand('/foobar arg')).toBeNull();
  });

  it('returns null for non-slash input', () => {
    expect(parseSlashCommand('xyz')).toBeNull();
    expect(parseSlashCommand('hello /clear')).toBeNull();
    expect(parseSlashCommand('  ')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  it('matches /compact and /help', () => {
    expect(parseSlashCommand('/compact')?.name).toBe('/compact');
    expect(parseSlashCommand('/help')?.name).toBe('/help');
  });

  it('matches /flow and ignores the intent tail for the lookup', () => {
    expect(parseSlashCommand('/flow erstelle eine webseite')?.name).toBe('/flow');
    expect(parseSlashCommand('/FLOW build a thing')?.name).toBe('/flow');
    expect(parseSlashCommand('/flow')?.name).toBe('/flow');
  });
});

// ---------------------------------------------------------------------------
// extractSlashArgs
// ---------------------------------------------------------------------------

describe('extractSlashArgs', () => {
  it('returns the verbatim tail after the command name', () => {
    expect(extractSlashArgs('/flow erstelle eine webseite')).toBe(
      'erstelle eine webseite',
    );
  });

  it('collapses leading whitespace but preserves inner casing/spacing', () => {
    expect(extractSlashArgs('/flow   Build A Thing  ')).toBe('Build A Thing');
  });

  it('returns empty string when there is no tail', () => {
    expect(extractSlashArgs('/flow')).toBe('');
    expect(extractSlashArgs('  ')).toBe('');
    expect(extractSlashArgs('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// trimByWorkstream
// ---------------------------------------------------------------------------

describe('trimByWorkstream', () => {
  it('keeps only the youngest item per (workstreamId, surfaceKind) coord', () => {
    const items = [
      mkItem({
        id: '1',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: 'ws-a',
        surfaceKind: 'consensus-action',
      }),
      mkItem({
        id: '2',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: 'ws-a',
        surfaceKind: 'consensus-action',
      }),
      mkItem({
        id: '3',
        ts: '2026-04-29T10:02:00Z',
        workstreamId: 'ws-a',
        surfaceKind: 'consensus-action',
      }),
    ];
    const out = trimByWorkstream(items, 6);
    expect(out.map((i) => i.id)).toEqual(['3']);
  });

  it('keeps last N free messages without coord', () => {
    const items: HistoryItem[] = [];
    for (let i = 0; i < 10; i += 1) {
      items.push(
        mkItem({
          id: `m${i}`,
          ts: `2026-04-29T10:${String(i).padStart(2, '0')}:00Z`,
          role: 'user',
          content: `msg ${i}`,
        }),
      );
    }
    const out = trimByWorkstream(items, 6);
    expect(out.map((i) => i.id)).toEqual(['m4', 'm5', 'm6', 'm7', 'm8', 'm9']);
  });

  it('mixes coord-keep + free-keep deterministically', () => {
    const items = [
      mkItem({ id: 'free-1', ts: '2026-04-29T10:00:00Z', content: 'hi' }),
      mkItem({
        id: 'coord-old',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: 'ws-x',
        surfaceKind: 'consensus-action',
      }),
      mkItem({ id: 'free-2', ts: '2026-04-29T10:02:00Z', content: 'hi 2' }),
      mkItem({
        id: 'coord-new',
        ts: '2026-04-29T10:03:00Z',
        workstreamId: 'ws-x',
        surfaceKind: 'consensus-action',
      }),
    ];
    const out = trimByWorkstream(items, 6);
    // coord-old wird verdraengt, coord-new bleibt; freie Items bleiben (<6).
    expect(out.map((i) => i.id)).toEqual(['free-1', 'free-2', 'coord-new']);
  });

  it('reads coord from content when fields missing (fallback)', () => {
    const items = [
      mkItem({
        id: 'a',
        ts: '2026-04-29T10:00:00Z',
        content:
          '<surface:consensus-action>{"workstreamId":"ws-fallback","consensusLevel":"strong"}</surface:consensus-action>',
      }),
      mkItem({
        id: 'b',
        ts: '2026-04-29T10:01:00Z',
        content:
          '<surface:consensus-action>{"workstreamId":"ws-fallback","consensusLevel":"strong"}</surface:consensus-action>',
      }),
    ];
    const out = trimByWorkstream(items, 6);
    expect(out.map((i) => i.id)).toEqual(['b']);
  });

  it('returns empty input as-is', () => {
    expect(trimByWorkstream([], 6)).toEqual([]);
  });

  it('preserves order across mixed kinds', () => {
    const items = [
      mkItem({ id: 'f1', ts: '2026-04-29T10:00:00Z' }),
      mkItem({
        id: 'c-a',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: 'ws-1',
        surfaceKind: 'consensus-action',
      }),
      mkItem({
        id: 'c-b',
        ts: '2026-04-29T10:02:00Z',
        workstreamId: 'ws-2',
        surfaceKind: 'consensus-action',
      }),
      mkItem({ id: 'f2', ts: '2026-04-29T10:03:00Z' }),
    ];
    const out = trimByWorkstream(items, 6);
    expect(out.map((i) => i.id)).toEqual(['f1', 'c-a', 'c-b', 'f2']);
  });
});

// ---------------------------------------------------------------------------
// /clear handler
// ---------------------------------------------------------------------------

describe('/clear handler', () => {
  it('clears history via setHistory([]) and pushes a toast', async () => {
    const cmd = REGISTRY.get('/clear');
    expect(cmd).toBeDefined();
    const startHistory = [
      mkItem({ id: '1', ts: '2026-04-29T10:00:00Z', role: 'user' }),
      mkItem({ id: '2', ts: '2026-04-29T10:01:00Z', role: 'assistant' }),
    ];
    const { ctx, toasts, setHistorySpy } = mkCtx({ history: startHistory });
    const result = await cmd!.handler(ctx);
    expect(result).toBe('consumed');
    expect(setHistorySpy).toHaveBeenCalledWith([]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('slash-clear');
    expect(toasts[0].content).toContain('Chat-Verlauf geleert');
  });

  it('clears localStorage key for the workspace', async () => {
    // happy-dom liefert localStorage.
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem('lazyos.chat.history.ws-clr', JSON.stringify([{ id: '1' }]));
    expect(window.localStorage.getItem('lazyos.chat.history.ws-clr')).not.toBeNull();
    const cmd = REGISTRY.get('/clear');
    const { ctx } = mkCtx({ workspaceId: 'ws-clr' });
    await cmd!.handler(ctx);
    expect(window.localStorage.getItem('lazyos.chat.history.ws-clr')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /compact handler
// ---------------------------------------------------------------------------

describe('/compact handler', () => {
  it('trims history locally and POSTs /api/ctx/compact-snapshot', async () => {
    const cmd = REGISTRY.get('/compact');
    expect(cmd).toBeDefined();
    const items: HistoryItem[] = [];
    for (let i = 0; i < 12; i += 1) {
      items.push(
        mkItem({
          id: `m${i}`,
          ts: `2026-04-29T10:${String(i).padStart(2, '0')}:00Z`,
          role: 'user',
          content: `msg ${i}`,
        }),
      );
    }
    const { ctx, fetchSpy, setHistorySpy, toasts } = mkCtx({
      history: items,
      workspaceId: 'ws-cpt',
    });
    const result = await cmd!.handler(ctx);
    expect(result).toBe('consumed');
    // History wurde getrimmt — letzte 6 freie Messages.
    expect(setHistorySpy).toHaveBeenCalledTimes(1);
    const call = setHistorySpy.mock.calls[0][0] as HistoryItem[];
    expect(call.map((i) => i.id)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10', 'm11']);
    // Server-Snapshot-Endpoint wurde aufgerufen.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ctx/compact-snapshot');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ workspaceId: 'ws-cpt' });
    // Toast.
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('slash-compact');
    expect(toasts[0].content).toContain('Server-Snapshot');
  });

  it('emits a warn-toast when the snapshot endpoint fails', async () => {
    const cmd = REGISTRY.get('/compact');
    const failingFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ hint: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { ctx, toasts } = mkCtx({
      history: [mkItem({ id: 'a', ts: '2026-04-29T10:00:00Z' })],
      fetch: failingFetch as unknown as typeof fetch,
    });
    await cmd!.handler(ctx);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('slash-compact-partial');
    expect(toasts[0].severity).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// /help handler
// ---------------------------------------------------------------------------

describe('/help handler', () => {
  it('pushes a toast listing all commands alphabetically', async () => {
    const cmd = REGISTRY.get('/help');
    expect(cmd).toBeDefined();
    const { ctx, toasts } = mkCtx();
    const result = await cmd!.handler(ctx);
    expect(result).toBe('consumed');
    expect(toasts).toHaveLength(1);
    const t = toasts[0];
    expect(t.kind).toBe('slash-help');
    // Body enthaelt alle Built-In-Namen, alphabetisch sortiert.
    // Surface-Toast-JSON: parse den body raus.
    const match = t.content.match(/<surface:toast>([\s\S]*)<\/surface:toast>/);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]) as { body?: string };
    const body = payload.body ?? '';
    const idxClear = body.indexOf('/clear');
    const idxCompact = body.indexOf('/compact');
    const idxHelp = body.indexOf('/help');
    expect(idxClear).toBeGreaterThanOrEqual(0);
    expect(idxCompact).toBeGreaterThan(idxClear);
    expect(idxHelp).toBeGreaterThan(idxCompact);
  });

  it('lists /flow in the help body', async () => {
    const cmd = REGISTRY.get('/help');
    const { ctx, toasts } = mkCtx();
    await cmd!.handler(ctx);
    const match = toasts[0].content.match(/<surface:toast>([\s\S]*)<\/surface:toast>/);
    const payload = JSON.parse(match![1]) as { body?: string };
    expect((payload.body ?? '').indexOf('/flow')).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// /flow handler (Track-D · 2026-05-27 — Flow Studio)
// ---------------------------------------------------------------------------

describe('/flow handler', () => {
  it('is registered', () => {
    expect(REGISTRY.get('/flow')).toBeDefined();
  });

  it('POSTs intent + workspaceId to /api/flow/compose-and-run', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({ status: 'running', flowId: 'fl-1', runId: 'r-1', workstreamId: 'ws-1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const posted: string[] = [];
    const { ctx } = mkCtx({
      workspaceId: 'ws-flow',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    ctx.args = 'erstelle eine webseite';
    ctx.postAssistantMessage = (c: string) => posted.push(c);

    const result = await cmd.handler(ctx);
    expect(result).toBe('consumed');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/flow/compose-and-run');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      intent: 'erstelle eine webseite',
      workspaceId: 'ws-flow',
    });
  });

  it('running-response posts a confirmation assistant message', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({ status: 'running', flowId: 'fl-1', runId: 'r-1', workstreamId: 'ws-1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const posted: string[] = [];
    const toasts: SystemItem[] = [];
    const { ctx } = mkCtx({ fetch: fetchSpy as unknown as typeof fetch });
    ctx.args = 'mach was';
    ctx.postAssistantMessage = (c: string) => posted.push(c);
    ctx.pushSystemToast = (t) => toasts.push(t);

    await cmd.handler(ctx);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Flow gestartet');
    // Bestaetigung darf KEIN coupling-Surface enthalten.
    expect(posted[0]).not.toContain('<surface:flow-coupling>');
  });

  it('needs-coupling-response posts <surface:flow-coupling> markup with correct JSON', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const missingTools = [
      {
        stepId: 'step-1',
        stepTitle: 'Bild generieren',
        provider: 'imagegen2',
        neededCapabilities: ['image.generate'],
        reason: 'credential',
      },
    ];
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({ status: 'needs-coupling', flowId: 'fl-42', missingTools }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const posted: string[] = [];
    const { ctx } = mkCtx({
      workspaceId: 'ws-cpl',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    ctx.args = 'erstelle ein Video';
    ctx.postAssistantMessage = (c: string) => posted.push(c);

    const result = await cmd.handler(ctx);
    expect(result).toBe('consumed');
    expect(posted).toHaveLength(1);
    const match = posted[0].match(
      /<surface:flow-coupling>([\s\S]*)<\/surface:flow-coupling>/,
    );
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]) as {
      flowId: string;
      workspaceId: string;
      missingTools: typeof missingTools;
    };
    expect(payload.flowId).toBe('fl-42');
    expect(payload.workspaceId).toBe('ws-cpl');
    expect(payload.missingTools).toEqual(missingTools);
  });

  it('warns (no fetch) when the intent tail is empty', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const fetchSpy = vi.fn();
    const toasts: SystemItem[] = [];
    const { ctx } = mkCtx({ fetch: fetchSpy as unknown as typeof fetch });
    ctx.args = '   ';
    ctx.pushSystemToast = (t) => toasts.push(t);

    const result = await cmd.handler(ctx);
    expect(result).toBe('consumed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('warn');
  });

  it('emits an error toast on a network failure', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const fetchSpy = vi.fn(async () => {
      throw new Error('network down');
    });
    const toasts: SystemItem[] = [];
    const posted: string[] = [];
    const { ctx } = mkCtx({ fetch: fetchSpy as unknown as typeof fetch });
    ctx.args = 'tu was';
    ctx.pushSystemToast = (t) => toasts.push(t);
    ctx.postAssistantMessage = (c) => posted.push(c);

    const result = await cmd.handler(ctx);
    expect(result).toBe('consumed');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('critical');
    expect(toasts[0].content).toContain('network down');
    expect(posted).toHaveLength(0);
  });

  it('emits a clear auth error toast on 401', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'auth-required' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const toasts: SystemItem[] = [];
    const { ctx } = mkCtx({ fetch: fetchSpy as unknown as typeof fetch });
    ctx.args = 'tu was';
    ctx.pushSystemToast = (t) => toasts.push(t);

    await cmd.handler(ctx);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('critical');
    expect(toasts[0].content).toContain('eingeloggt');
  });

  // ── Stream-B2: needs-style-choice (Stil-Wahl) ───────────────────────────
  it('needs-style-choice → delegiert an onFlowStyleChoice (Intent + Prompts inkl. choiceKey)', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: 'needs-style-choice',
          flowId: 'FLOW-7',
          styleChoices: [
            {
              step: {
                stepId: 'FSTEP-1',
                idx: 1,
                stepTitle: 'Hero-Video',
                skill: 'tool:video',
                kind: 'video',
              },
              payload: {
                variant: 'quickchoice',
                stepId: 'FSTEP-1',
                stepTitle: 'Hero-Video',
                stepKind: 'video',
                flowId: 'FLOW-7',
                options: [
                  { id: 'video-higgsfield', label: 'Eigenes Video (Higgsfield)', sublabel: '…', primary: true },
                  { id: 'video-procedural', label: 'Prozedural', sublabel: '…' },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const requests: FlowStyleChoiceRequest[] = [];
    const { ctx } = mkCtx({
      workspaceId: 'ws-flow',
      fetch: fetchSpy as unknown as typeof fetch,
    });
    ctx.args = 'Landingpage mit Hero-Video';
    ctx.postAssistantMessage = () => {};
    ctx.onFlowStyleChoice = (r) => requests.push(r);

    const result = await cmd.handler(ctx);
    expect(result).toBe('consumed');
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.intent).toBe('Landingpage mit Hero-Video'); // verbatim
    expect(req.workspaceId).toBe('ws-flow');
    expect(req.flowId).toBe('FLOW-7');
    expect(req.prompts).toHaveLength(1);
    // Stabiler styleChoices-Schlüssel = String(step.idx).
    expect(req.prompts[0].choiceKey).toBe('1');
    expect(req.prompts[0].optionIds).toEqual(['video-higgsfield', 'video-procedural']);
    expect(req.prompts[0].payload.variant).toBe('quickchoice');
  });

  it('needs-style-choice ohne onFlowStyleChoice-Callback → postet die quickchoice-Surface(s)', async () => {
    const cmd = REGISTRY.get('/flow')!;
    const fetchSpy = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: 'needs-style-choice',
          flowId: 'FLOW-7',
          styleChoices: [
            {
              step: { stepId: 'FSTEP-1', idx: 2, stepTitle: 'Hero', skill: 'tool:video', kind: 'video' },
              payload: {
                variant: 'quickchoice',
                stepId: 'FSTEP-1',
                stepTitle: 'Hero',
                stepKind: 'video',
                flowId: 'FLOW-7',
                options: [{ id: 'video-higgsfield', label: 'x', sublabel: 'y' }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const posted: string[] = [];
    const { ctx } = mkCtx({ fetch: fetchSpy as unknown as typeof fetch });
    ctx.args = 'tu was';
    ctx.postAssistantMessage = (c) => posted.push(c);
    // KEIN onFlowStyleChoice gesetzt → Fallback-Pfad.

    await cmd.handler(ctx);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('<surface:prompt>');
    expect(posted[0]).toContain('quickchoice');
    expect(posted[0]).toContain('video-higgsfield');
  });
});

// ---------------------------------------------------------------------------
// handleFlowComposeResult (Stream-B2) — pure Status-Übersetzung
// ---------------------------------------------------------------------------

describe('handleFlowComposeResult', () => {
  function makeSink() {
    return {
      running: 0,
      couplings: [] as string[],
      styleReqs: [] as FlowStyleChoiceRequest[],
      errors: [] as string[],
    };
  }
  function ctxFor(sink: ReturnType<typeof makeSink>, intent = 'i', workspaceId = 'ws') {
    return {
      intent,
      workspaceId,
      onRunning: () => { sink.running += 1; },
      onCoupling: (m: string) => sink.couplings.push(m),
      onStyleChoice: (r: FlowStyleChoiceRequest) => sink.styleReqs.push(r),
      onError: (d: string) => sink.errors.push(d),
    };
  }

  it('running → onRunning', () => {
    const sink = makeSink();
    const ok = handleFlowComposeResult(
      { status: 'running', flowId: 'f', runId: 'r', workstreamId: 'w' },
      ctxFor(sink),
    );
    expect(ok).toBe(true);
    expect(sink.running).toBe(1);
  });

  it('needs-coupling → onCoupling mit korrektem <surface:flow-coupling>-JSON', () => {
    const sink = makeSink();
    const missingTools = [
      { stepId: 's1', stepTitle: 'Bild', provider: 'imagegen2', neededCapabilities: ['image.generate'], reason: 'credential' },
    ];
    handleFlowComposeResult(
      { status: 'needs-coupling', flowId: 'fl-42', missingTools } as never,
      ctxFor(sink, 'i', 'ws-x'),
    );
    expect(sink.couplings).toHaveLength(1);
    const m = sink.couplings[0].match(/<surface:flow-coupling>([\s\S]*)<\/surface:flow-coupling>/);
    expect(m).not.toBeNull();
    const payload = JSON.parse(m![1]) as { flowId: string; workspaceId: string; missingTools: unknown[] };
    expect(payload.flowId).toBe('fl-42');
    expect(payload.workspaceId).toBe('ws-x');
    expect(payload.missingTools).toEqual(missingTools);
  });

  it('needs-style-choice mit MEHREREN Steps → ein Request mit choiceKeys aus step.idx', () => {
    const sink = makeSink();
    const mkPrompt = (idx: number, opts: string[]) => ({
      step: { stepId: `FSTEP-${idx}`, idx, stepTitle: `Step ${idx}`, skill: 'tool:image', kind: 'image' },
      payload: {
        variant: 'quickchoice',
        stepId: `FSTEP-${idx}`,
        stepTitle: `Step ${idx}`,
        stepKind: 'image',
        flowId: 'FLOW-multi',
        options: opts.map((id) => ({ id, label: id, sublabel: '' })),
      },
    });
    handleFlowComposeResult(
      {
        status: 'needs-style-choice',
        flowId: 'FLOW-multi',
        styleChoices: [
          mkPrompt(1, ['image-imagegen2', 'image-placeholder']),
          mkPrompt(3, ['image-imagegen2', 'image-stockphoto']),
        ],
      } as never,
      ctxFor(sink, 'baue 2 bilder', 'ws-m'),
    );
    expect(sink.styleReqs).toHaveLength(1);
    const req = sink.styleReqs[0]!;
    expect(req.prompts.map((p) => p.choiceKey)).toEqual(['1', '3']);
    expect(req.prompts[0].optionIds).toEqual(['image-imagegen2', 'image-placeholder']);
    expect(req.intent).toBe('baue 2 bilder');
  });

  it('needs-style-choice OHNE idx → Fallback auf payload.stepId als choiceKey', () => {
    const sink = makeSink();
    handleFlowComposeResult(
      {
        status: 'needs-style-choice',
        flowId: 'FLOW-x',
        styleChoices: [
          {
            step: { stepId: 'FSTEP-fallback', stepTitle: 'x', skill: 'tool:video', kind: 'video' },
            payload: {
              variant: 'quickchoice',
              stepId: 'FSTEP-fallback',
              stepTitle: 'x',
              stepKind: 'video',
              flowId: 'FLOW-x',
              options: [{ id: 'video-higgsfield', label: 'x', sublabel: '' }],
            },
          },
        ],
      } as never,
      ctxFor(sink),
    );
    expect(sink.styleReqs[0]!.prompts[0].choiceKey).toBe('FSTEP-fallback');
  });

  it('needs-style-choice ohne brauchbare Prompts → onError', () => {
    const sink = makeSink();
    const ok = handleFlowComposeResult(
      { status: 'needs-style-choice', flowId: 'f', styleChoices: [] } as never,
      ctxFor(sink),
    );
    expect(ok).toBe(false);
    expect(sink.errors).toHaveLength(1);
    expect(sink.styleReqs).toHaveLength(0);
  });

  it('null/fehlender Status → onError', () => {
    const sink = makeSink();
    expect(handleFlowComposeResult(null, ctxFor(sink))).toBe(false);
    expect(handleFlowComposeResult({} as never, ctxFor(sink))).toBe(false);
    expect(sink.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('unbekannter Status → onError', () => {
    const sink = makeSink();
    const ok = handleFlowComposeResult({ status: 'bogus' } as never, ctxFor(sink));
    expect(ok).toBe(false);
    expect(sink.errors[0]).toContain('bogus');
  });
});

// ---------------------------------------------------------------------------
// correlateQuickChoice (Stream-B2) — id → offene Frage + Session-Vervollständigung
// ---------------------------------------------------------------------------

describe('correlateQuickChoice', () => {
  function mkSession(
    prompts: Array<{ choiceKey: string; optionIds: string[] }>,
    overrides: Partial<FlowStyleSession> = {},
  ): FlowStyleSession {
    return {
      intent: overrides.intent ?? 'i',
      workspaceId: overrides.workspaceId ?? 'ws',
      pending: prompts.map((p) => ({ choiceKey: p.choiceKey, optionIds: p.optionIds })),
      choices: {},
    };
  }

  it('ordnet eine geklickte id ihrem offenen Prompt zu (mutiert choices + pending)', () => {
    const session = mkSession([
      { choiceKey: '1', optionIds: ['video-higgsfield', 'video-procedural'] },
    ]);
    const r = correlateQuickChoice([session], 'video-procedural');
    expect(r.matched).toBe(true);
    expect(r.sessionIndex).toBe(0);
    expect(session.choices).toEqual({ '1': 'video-procedural' });
    // Einziger Prompt beantwortet → Session vollständig.
    expect(r.completedSession).toBe(session);
    expect(session.pending).toHaveLength(0);
  });

  it('mehrere Steps: erst nach ALLEN Klicks ist die Session vollständig (gebündelt)', () => {
    const session = mkSession([
      { choiceKey: '1', optionIds: ['image-imagegen2', 'image-placeholder'] },
      { choiceKey: '3', optionIds: ['video-higgsfield', 'video-procedural'] },
    ]);
    const first = correlateQuickChoice([session], 'image-imagegen2');
    expect(first.matched).toBe(true);
    expect(first.completedSession).toBeNull(); // noch ein Prompt offen
    expect(session.pending).toHaveLength(1);

    const second = correlateQuickChoice([session], 'video-higgsfield');
    expect(second.matched).toBe(true);
    expect(second.completedSession).toBe(session);
    expect(session.choices).toEqual({ '1': 'image-imagegen2', '3': 'video-higgsfield' });
  });

  it('identische Option-Mengen → der Reihe nach (erster offener Prompt zuerst)', () => {
    const session = mkSession([
      { choiceKey: '0', optionIds: ['video-higgsfield', 'video-procedural'] },
      { choiceKey: '2', optionIds: ['video-higgsfield', 'video-procedural'] },
    ]);
    correlateQuickChoice([session], 'video-higgsfield'); // → choiceKey 0
    expect(session.choices).toEqual({ '0': 'video-higgsfield' });
    correlateQuickChoice([session], 'video-procedural'); // → choiceKey 2
    expect(session.choices).toEqual({ '0': 'video-higgsfield', '2': 'video-procedural' });
  });

  it('unbekannte id → kein Match, keine Mutation', () => {
    const session = mkSession([{ choiceKey: '1', optionIds: ['video-higgsfield'] }]);
    const r = correlateQuickChoice([session], 'something-else');
    expect(r.matched).toBe(false);
    expect(r.completedSession).toBeNull();
    expect(session.pending).toHaveLength(1);
    expect(session.choices).toEqual({});
  });

  it('leere id / keine Sessions → kein Match', () => {
    expect(correlateQuickChoice([], 'x').matched).toBe(false);
    const session = mkSession([{ choiceKey: '1', optionIds: ['a'] }]);
    expect(correlateQuickChoice([session], '').matched).toBe(false);
  });

  it('mehrere Sessions: trifft die erste mit passendem offenem Prompt', () => {
    const s1 = mkSession([{ choiceKey: '1', optionIds: ['avatar-heygen', 'avatar-none'] }], {
      intent: 'erste',
    });
    const s2 = mkSession([{ choiceKey: '1', optionIds: ['avatar-heygen', 'avatar-none'] }], {
      intent: 'zweite',
    });
    const r = correlateQuickChoice([s1, s2], 'avatar-none');
    expect(r.sessionIndex).toBe(0);
    expect(r.completedSession).toBe(s1);
    expect(s1.choices).toEqual({ '1': 'avatar-none' });
    expect(s2.choices).toEqual({}); // unberührt
  });
});
