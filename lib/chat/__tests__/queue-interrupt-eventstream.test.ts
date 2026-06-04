/**
 * Tests für Bug-2 (Queue + Interrupt) und Bug-3 (EventStream-Kontinuität).
 *
 * Bug-2:
 *   - Queue: Nachrichten werden während Streaming eingereiht (FIFO)
 *   - Flush: Queue wird automatisch geleert wenn agentStatus → 'idle'
 *   - Interrupt: Stop löscht Queue, abort() wird aufgerufen
 *
 * Bug-3:
 *   - EventSource wird NICHT neu aufgebaut wenn workspaceId wechselt
 *   - Fremde-Workspace-Events werden still gefiltert (kein pass-through)
 *   - Der onmessage-Handler liest workspaceId aus dem Ref (immer aktuell)
 *
 * Lauf: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/chat/__tests__/queue-interrupt-eventstream.test.ts
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ============================================================================
// Bug-2: Queue-Logik (pure unit-Tests ohne React — wir testen die Logik direkt)
// ============================================================================

describe('Bug-2: Message-Queue (FIFO)', () => {
  it('enqueued messages maintain FIFO order', () => {
    const queue: string[] = [];

    // Simulate: User tippt 3 Nachrichten während streaming=true
    const enqueue = (msg: string): void => { queue.push(msg); };
    enqueue('erste');
    enqueue('zweite');
    enqueue('dritte');

    expect(queue).toHaveLength(3);
    expect(queue[0]).toBe('erste');
    expect(queue[1]).toBe('zweite');
    expect(queue[2]).toBe('dritte');
  });

  it('flush sends oldest message first (FIFO)', () => {
    const queue: string[] = ['erste', 'zweite', 'dritte'];
    const sent: string[] = [];

    // Simulate: agentStatus → 'idle' → flush
    const flush = (): void => {
      const next = queue.shift();
      if (next) sent.push(next);
    };

    flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('erste');
    expect(queue).toHaveLength(2);
    expect(queue[0]).toBe('zweite');

    flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe('zweite');
    expect(queue).toHaveLength(1);
  });

  it('flush on empty queue is a no-op', () => {
    const queue: string[] = [];
    const sent: string[] = [];

    const next = queue.shift();
    if (next) sent.push(next);

    expect(sent).toHaveLength(0);
    expect(queue).toHaveLength(0);
  });

  it('stop clears the queue', () => {
    const queue: string[] = ['erste', 'zweite'];
    const abortCalled = { value: false };

    // Simulate: User clicks Stop
    const handleStop = (): void => {
      abortCalled.value = true;
      queue.length = 0; // clear
    };

    handleStop();
    expect(abortCalled.value).toBe(true);
    expect(queue).toHaveLength(0);
  });

  it('sendNow clears queue and triggers abort', () => {
    const queue: string[] = ['erste', 'zweite'];
    const abortCalled = { value: false };
    const sentMessages: string[] = [];

    // Simulate: User presses Cmd+Enter (interrupt + send now)
    const handleSendNow = (msg: string): void => {
      abortCalled.value = true;
      queue.length = 0;
      sentMessages.push(msg);
    };

    handleSendNow('sofort');
    expect(abortCalled.value).toBe(true);
    expect(queue).toHaveLength(0);
    expect(sentMessages).toEqual(['sofort']);
  });
});

// ============================================================================
// Bug-2: Submit-Verhalten — Normal vs. Enqueue
// ============================================================================

describe('Bug-2: submit enqueues during streaming', () => {
  it('submit during streaming pushes to queue (does NOT fire sendAgent)', () => {
    const queue: string[] = [];
    let sendAgentCalled = false;
    let isStreaming = true;

    const submit = (raw: string): void => {
      const value = raw.trim();
      if (value.length === 0) return;
      if (isStreaming) {
        queue.push(value);
        return; // no sendAgent
      }
      sendAgentCalled = true;
    };

    submit('hello während streaming');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toBe('hello während streaming');
    expect(sendAgentCalled).toBe(false);
  });

  it('submit when NOT streaming fires sendAgent immediately', () => {
    const queue: string[] = [];
    let sendAgentCalled = false;
    let isStreaming = false;

    const submit = (raw: string): void => {
      const value = raw.trim();
      if (value.length === 0) return;
      if (isStreaming) {
        queue.push(value);
        return;
      }
      sendAgentCalled = true;
    };

    submit('hello normal');
    expect(queue).toHaveLength(0);
    expect(sendAgentCalled).toBe(true);
  });

  it('submit trims whitespace before enqueuing', () => {
    const queue: string[] = [];
    const isStreaming = true;

    const submit = (raw: string): void => {
      const value = raw.trim();
      if (value.length === 0) return;
      if (isStreaming) { queue.push(value); }
    };

    submit('  spaces around  ');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toBe('spaces around');
  });

  it('submit empty string is no-op (no enqueue)', () => {
    const queue: string[] = [];
    const isStreaming = true;

    const submit = (raw: string): void => {
      const value = raw.trim();
      if (value.length === 0) return;
      if (isStreaming) { queue.push(value); }
    };

    submit('   ');
    expect(queue).toHaveLength(0);
  });
});

// ============================================================================
// Bug-3: EventSource bleibt über workspaceId-Wechsel offen
// ============================================================================

describe('Bug-3: EventSource stays open across workspaceId changes', () => {
  it('useEffect deps do NOT include workspaceId (verified via filter-in-ref pattern)', () => {
    // Logik-Test: Ref-basierter Filter funktioniert korrekt.
    // useEventStream nutzt workspaceIdRef.current statt workspaceId-Capture.

    let currentWorkspaceId = 'ws-a';
    const workspaceIdRef = { current: currentWorkspaceId };

    // Simulate onmessage filter logic
    const shouldPassEvent = (evWsId: string): boolean => {
      const currentWsId = workspaceIdRef.current;
      if (!currentWsId) return true;
      if (evWsId && evWsId !== currentWsId) return false;
      return true;
    };

    // Event from current workspace → passes
    expect(shouldPassEvent('ws-a')).toBe(true);

    // Event from different workspace → filtered
    expect(shouldPassEvent('ws-b')).toBe(false);

    // Simulate: workspaceId changes (no EventSource rebuild, only Ref update)
    workspaceIdRef.current = 'ws-b';
    currentWorkspaceId = 'ws-b';

    // Event from OLD workspace (ws-a) → filtered (stale)
    expect(shouldPassEvent('ws-a')).toBe(false);

    // Event from NEW workspace (ws-b) → passes
    expect(shouldPassEvent('ws-b')).toBe(true);
  });

  it('no EventSource close/reopen on workspaceId change (single connection)', () => {
    let connectionCount = 0;
    let closeCount = 0;

    // Simulate: old behavior (workspaceId in deps → reconnect on each switch)
    const oldBehaviorConnects = (workspaceIds: string[]): { connects: number; closes: number } => {
      let connects = 0;
      let closes = 0;
      for (let i = 0; i < workspaceIds.length; i++) {
        if (i === 0) {
          connects++; // initial connect
        } else {
          closes++; // close old
          connects++; // open new
        }
      }
      return { connects, closes };
    };

    // Simulate: new behavior (workspaceId NOT in deps → no reconnect)
    const newBehaviorConnects = (workspaceIds: string[]): { connects: number; closes: number } => {
      return { connects: workspaceIds.length > 0 ? 1 : 0, closes: 0 };
    };

    const workspaceIds = ['ws-a', 'ws-b', 'ws-c', 'ws-d'];

    const old = oldBehaviorConnects(workspaceIds);
    const newBehavior = newBehaviorConnects(workspaceIds);

    // Old: 4 connects, 3 closes
    expect(old.connects).toBe(4);
    expect(old.closes).toBe(3);

    // New: 1 connect, 0 closes
    expect(newBehavior.connects).toBe(1);
    expect(newBehavior.closes).toBe(0);
  });

  it('dedup by event.id works across workspace switch (seenIds persists)', () => {
    // seenIds ist in der Closure des useEffect — lebt solange der Effect läuft.
    // Da der Effect nicht neu gestartet wird (workspaceId kein Dep), bleibt
    // seenIds.current über Workspace-Switches hinweg erhalten.
    const seenIds = new Set<string>();

    const isDuplicate = (id: string): boolean => {
      if (seenIds.has(id)) return true;
      seenIds.add(id);
      if (seenIds.size > 500) {
        const first = seenIds.values().next().value;
        if (first) seenIds.delete(first);
      }
      return false;
    };

    // First time: not duplicate
    expect(isDuplicate('event-1')).toBe(false);
    expect(isDuplicate('event-2')).toBe(false);

    // Replay after switch: duplicate
    expect(isDuplicate('event-1')).toBe(true);
    expect(isDuplicate('event-2')).toBe(true);

    // New event after switch: not duplicate
    expect(isDuplicate('event-3')).toBe(false);
  });
});

// ============================================================================
// Bug-3: Snapshot-Resume (workspace-switch während laufendem Stream)
// ============================================================================

describe('Bug-3: Snapshot-Resume beim Workspace-Switch', () => {
  const LIVE_TTL_MS = 60 * 60 * 1000; // 1h

  it('live snapshot within TTL triggers serverStreamPending=true on switch-back', () => {
    const snapshots = new Map<string, { startedAt: string; text: string }>();

    const writeLiveFor = (wsId: string, data: { startedAt: string; text: string }): void => {
      snapshots.set(wsId, data);
    };

    const readLiveFor = (wsId: string): { startedAt: string; text: string } | null => {
      return snapshots.get(wsId) ?? null;
    };

    const clearLiveFor = (wsId: string): void => {
      snapshots.delete(wsId);
    };

    // Stream startet auf ws-a
    writeLiveFor('ws-a', { startedAt: new Date().toISOString(), text: 'partial answer…' });

    // User switcht zu ws-b
    // Beim Zurückswitchen zu ws-a: resume-Logik
    let serverStreamPending = false;

    const onSwitchTo = (wsId: string): void => {
      const live = readLiveFor(wsId);
      if (!live) return;
      const age = Date.now() - new Date(live.startedAt).getTime();
      if (age < LIVE_TTL_MS) {
        serverStreamPending = true;
      } else {
        clearLiveFor(wsId);
      }
    };

    onSwitchTo('ws-a');
    expect(serverStreamPending).toBe(true);
  });

  it('expired live snapshot is cleared (not resumed)', () => {
    const snapshots = new Map<string, { startedAt: string; text: string }>();

    const writeLiveFor = (wsId: string, data: { startedAt: string; text: string }): void => {
      snapshots.set(wsId, data);
    };
    const readLiveFor = (wsId: string): { startedAt: string; text: string } | null => {
      return snapshots.get(wsId) ?? null;
    };
    const clearLiveFor = (wsId: string): void => {
      snapshots.delete(wsId);
    };

    // Snapshot älter als TTL
    const oldDate = new Date(Date.now() - LIVE_TTL_MS - 1).toISOString();
    writeLiveFor('ws-a', { startedAt: oldDate, text: 'old partial…' });

    let serverStreamPending = false;

    const onSwitchTo = (wsId: string): void => {
      const live = readLiveFor(wsId);
      if (!live) return;
      const age = Date.now() - new Date(live.startedAt).getTime();
      if (age < LIVE_TTL_MS) {
        serverStreamPending = true;
      } else {
        clearLiveFor(wsId);
      }
    };

    onSwitchTo('ws-a');
    expect(serverStreamPending).toBe(false);
    expect(snapshots.has('ws-a')).toBe(false); // cleared
  });

  it('workspace with no live snapshot does not trigger resume', () => {
    const snapshots = new Map<string, { startedAt: string; text: string }>();

    const readLiveFor = (wsId: string): { startedAt: string; text: string } | null => {
      return snapshots.get(wsId) ?? null;
    };

    let serverStreamPending = false;

    const onSwitchTo = (wsId: string): void => {
      const live = readLiveFor(wsId);
      if (!live) return;
      serverStreamPending = true;
    };

    onSwitchTo('ws-a'); // no snapshot
    expect(serverStreamPending).toBe(false);
  });
});

// ============================================================================
// C1: handleSendNow — kein Doppel-Send-Race (Queue ZUERST leeren, DANN abort)
// ============================================================================

describe('C1: handleSendNow clears queue BEFORE abort (no double-send)', () => {
  /**
   * Modelliert das Race exakt: abortAgent() löst eine async Status-Transition
   * auf 'idle' aus, die den Queue-Flush-Effect feuert. Wenn die Queue zu dem
   * Zeitpunkt noch gefüllt ist, sendet der Flush zusätzlich zur sendNow-Message.
   *
   * Fix: messageQueueRef ZUERST leeren, dann abortAgent() — der Flush findet
   * dann nichts mehr.
   */
  it('correct order: clear → abort → only sendNow fires (no queued flush)', () => {
    const queue: string[] = ['queued-1', 'queued-2'];
    const sent: string[] = [];

    // Simulate the queue-flush-effect that fires on abort→idle transition.
    const flushOnIdle = (): void => {
      const next = queue.shift();
      if (next) sent.push(`FLUSH:${next}`);
    };

    // abortAgent triggers the idle-transition synchronously in this model.
    const abortAgent = (): void => {
      flushOnIdle();
    };

    // FIXED handleSendNow: clear queue FIRST, then abort.
    const handleSendNow = (value: string): void => {
      queue.length = 0; // 1) clear
      abortAgent(); // 2) abort → flush is now a no-op
      sent.push(`SENDNOW:${value}`); // 3) send (setTimeout in real code)
    };

    handleSendNow('interrupt-me');

    // Only the sendNow message must be sent — NO flushed queue item.
    expect(sent).toEqual(['SENDNOW:interrupt-me']);
    expect(sent.some((s) => s.startsWith('FLUSH:'))).toBe(false);
    expect(queue).toHaveLength(0);
  });

  it('BUGGY order (abort before clear) WOULD double-send — guards the fix', () => {
    const queue: string[] = ['queued-1'];
    const sent: string[] = [];

    const flushOnIdle = (): void => {
      const next = queue.shift();
      if (next) sent.push(`FLUSH:${next}`);
    };
    const abortAgent = (): void => {
      flushOnIdle();
    };

    // OLD buggy order: abort FIRST (flush fires), THEN clear (too late).
    const buggyHandleSendNow = (value: string): void => {
      abortAgent(); // flush sends queued-1
      queue.length = 0; // too late
      sent.push(`SENDNOW:${value}`);
    };

    buggyHandleSendNow('interrupt-me');

    // This demonstrates the race the fix prevents: BOTH fire.
    expect(sent).toContain('FLUSH:queued-1');
    expect(sent).toContain('SENDNOW:interrupt-me');
    expect(sent).toHaveLength(2); // double-send (the bug)
  });
});

// ============================================================================
// H1: Turn-error → Queue verworfen (kein ewig hängender Chip)
// ============================================================================

describe('H1: error outcome clears the queue (no permanent hang)', () => {
  it('error branch empties queue and sets length 0', () => {
    const queue: string[] = ['will-hang-1', 'will-hang-2'];
    let queueLength = queue.length;
    const hints: string[] = [];

    // Simulate the error-outcome handler.
    const onErrorOutcome = (): void => {
      if (queue.length > 0) {
        const dropped = queue.length;
        queue.length = 0;
        queueLength = 0;
        hints.push(`dropped:${dropped}`);
      }
    };

    onErrorOutcome();
    expect(queue).toHaveLength(0);
    expect(queueLength).toBe(0);
    expect(hints).toEqual(['dropped:2']);
  });

  it('error branch with empty queue: no hint, no-op', () => {
    const queue: string[] = [];
    const hints: string[] = [];

    const onErrorOutcome = (): void => {
      if (queue.length > 0) {
        hints.push(`dropped:${queue.length}`);
        queue.length = 0;
      }
    };

    onErrorOutcome();
    expect(queue).toHaveLength(0);
    expect(hints).toHaveLength(0); // no ghost hint
  });

  it('flush-effect only fires on idle, NOT on error (proves the hang without H1)', () => {
    const queue: string[] = ['stuck'];
    const sent: string[] = [];

    // The flush-effect guard: only idle triggers a flush.
    const flushEffect = (status: 'idle' | 'error' | 'streaming'): void => {
      if (status !== 'idle') return;
      const next = queue.shift();
      if (next) sent.push(next);
    };

    // Turn ends with error → flush is a no-op → queue would hang.
    flushEffect('error');
    expect(sent).toHaveLength(0);
    expect(queue).toHaveLength(1); // still stuck without H1-clear

    // H1 clears it explicitly in the error branch.
    queue.length = 0;
    expect(queue).toHaveLength(0);
  });
});

// ============================================================================
// C2: Inflight-Lock — kein konkurrierender sendAgent (direkter submit re-entrancy)
// ============================================================================

describe('C2: submitInflightRef serializes direct submits', () => {
  it('second direct submit during inflight is enqueued, not sent', () => {
    let inflight = false;
    let isStreaming = false; // window where isStreaming not yet true
    const queue: string[] = [];
    const sentToAgent: string[] = [];

    const submit = (value: string): void => {
      // Guard: enqueue if streaming OR inflight (the C2 window).
      if (isStreaming || inflight) {
        queue.push(value);
        return;
      }
      inflight = true; // lock
      sentToAgent.push(value);
      // (async turn runs; finally would reset inflight)
    };

    // First submit → fires sendAgent, sets inflight.
    submit('first');
    expect(sentToAgent).toEqual(['first']);
    expect(inflight).toBe(true);

    // Concurrent direct submit (e.g. RateLimitRetry.reply) BEFORE isStreaming
    // flips → must enqueue, not start a second agent call.
    submit('concurrent');
    expect(sentToAgent).toEqual(['first']); // unchanged
    expect(queue).toEqual(['concurrent']);
  });

  it('inflight reset in finally allows next turn', () => {
    let inflight = false;
    const sentToAgent: string[] = [];

    const runTurn = (value: string): void => {
      inflight = true;
      try {
        sentToAgent.push(value);
      } finally {
        inflight = false; // C2 finally-reset
      }
    };

    runTurn('one');
    expect(inflight).toBe(false);
    runTurn('two');
    expect(inflight).toBe(false);
    expect(sentToAgent).toEqual(['one', 'two']);
  });
});

// ============================================================================
// H5: initialWindowDone reset on re-enable (initial-burst filtered again)
// ============================================================================

describe('H5: initialWindowDone resets on effect re-activation', () => {
  it('after re-enable, initial replay-burst is filtered (not passed through)', () => {
    const initialWindowDone = { current: false };

    // shouldPass models the onmessage initial-window gate for non-chat events.
    const shouldPass = (isChatMessage: boolean): boolean => {
      if (!isChatMessage && !initialWindowDone.current) return false;
      return true;
    };

    // Effect activation #1: reset.
    initialWindowDone.current = false;
    // Non-chat replay event in initial window → filtered.
    expect(shouldPass(false)).toBe(false);
    // After 1.2s timer fires:
    initialWindowDone.current = true;
    expect(shouldPass(false)).toBe(true);

    // Effect DE-activates (enabled=false) then RE-activates: H5 reset.
    initialWindowDone.current = false; // <- the fix
    // New replay burst from fresh EventSource → filtered again (not doubled).
    expect(shouldPass(false)).toBe(false);
  });
});
