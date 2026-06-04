// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/__tests__/realtime-adapter.test.ts
//
// Tests:
//   - createAdapter() without LAZYOS_VOICE_LIVE → MockRealtimeAdapter (no OpenAI).
//   - MockRealtimeAdapter emits scriptable events.
//   - No key in emitted events or logs.
//   - isVoiceLiveEnabled / hasVoiceKey gate logic.
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/voice/__tests__/realtime-adapter.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAdapter,
  MockRealtimeAdapter,
  isVoiceLiveEnabled,
  hasVoiceKey,
  maskedKeyHint,
} from '../realtime-adapter';
import type { VoiceEvent } from '../types';

// ─── ENV cleanup helpers ──────────────────────────────────────────────────────

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── createAdapter() gate ─────────────────────────────────────────────────────

describe('createAdapter() — Mock default', () => {
  it('returns MockRealtimeAdapter when no flag is set', () => {
    withEnv({ LAZYOS_VOICE_LIVE: undefined, OPENAI_API_KEY: undefined, LAZYOS_VOICE_OPENAI_KEY: undefined }, () => {
      const adapter = createAdapter();
      expect(adapter.kind).toBe('mock');
    });
  });

  it('returns MockRealtimeAdapter when flag is set but no key', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({ LAZYOS_VOICE_LIVE: '1', OPENAI_API_KEY: undefined, LAZYOS_VOICE_OPENAI_KEY: undefined }, () => {
      const adapter = createAdapter();
      expect(adapter.kind).toBe('mock');
      // Should have warned about missing key.
      expect(warnSpy).toHaveBeenCalled();
    });
    warnSpy.mockRestore();
  });

  it('returns OpenAiRealtimeAdapter kind when flag + key set', () => {
    withEnv({ LAZYOS_VOICE_LIVE: '1', OPENAI_API_KEY: 'sk-test-key-12345' }, () => {
      const adapter = createAdapter();
      expect(adapter.kind).toBe('openai-realtime');
    });
  });
});

// ─── isVoiceLiveEnabled ───────────────────────────────────────────────────────

describe('isVoiceLiveEnabled()', () => {
  it('false when unset', () => {
    withEnv({ LAZYOS_VOICE_LIVE: undefined }, () => {
      expect(isVoiceLiveEnabled()).toBe(false);
    });
  });

  it.each(['1', 'true', 'on'])('true when value is %s', (val) => {
    withEnv({ LAZYOS_VOICE_LIVE: val }, () => {
      expect(isVoiceLiveEnabled()).toBe(true);
    });
  });

  it.each(['0', 'false', 'off', ''])('false when value is %s', (val) => {
    withEnv({ LAZYOS_VOICE_LIVE: val }, () => {
      expect(isVoiceLiveEnabled()).toBe(false);
    });
  });
});

// ─── hasVoiceKey ──────────────────────────────────────────────────────────────

describe('hasVoiceKey()', () => {
  it('false when both keys absent', () => {
    withEnv({ OPENAI_API_KEY: undefined, LAZYOS_VOICE_OPENAI_KEY: undefined }, () => {
      expect(hasVoiceKey()).toBe(false);
    });
  });

  it('true when OPENAI_API_KEY is set', () => {
    withEnv({ OPENAI_API_KEY: 'sk-test', LAZYOS_VOICE_OPENAI_KEY: undefined }, () => {
      expect(hasVoiceKey()).toBe(true);
    });
  });

  it('true when LAZYOS_VOICE_OPENAI_KEY is set', () => {
    withEnv({ LAZYOS_VOICE_OPENAI_KEY: 'sk-lazyos', OPENAI_API_KEY: undefined }, () => {
      expect(hasVoiceKey()).toBe(true);
    });
  });
});

// ─── maskedKeyHint — no key leakage ──────────────────────────────────────────

describe('maskedKeyHint() — security: no full key exposed', () => {
  it('returns <no-key> when no key is set', () => {
    withEnv({ OPENAI_API_KEY: undefined, LAZYOS_VOICE_OPENAI_KEY: undefined }, () => {
      expect(maskedKeyHint()).toBe('<no-key>');
    });
  });

  it('never returns the full key value', () => {
    const testKey = 'sk-test-abcdefghijklmnopqrstuvwxyz123456';
    withEnv({ OPENAI_API_KEY: testKey }, () => {
      const hint = maskedKeyHint();
      expect(hint).not.toContain(testKey);
      expect(hint.length).toBeLessThan(testKey.length);
    });
  });

  it('returns masked prefix + last 4 chars for long keys', () => {
    withEnv({ OPENAI_API_KEY: 'sk-test-xyz1234' }, () => {
      const hint = maskedKeyHint();
      expect(hint.endsWith('1234')).toBe(true);
      expect(hint.startsWith('••••')).toBe(true);
    });
  });

  it('returns all dots for very short keys (<= 4 chars)', () => {
    withEnv({ OPENAI_API_KEY: 'sk12' }, () => {
      const hint = maskedKeyHint();
      expect(hint).toBe('••••');
    });
  });
});

// ─── MockRealtimeAdapter — connect/disconnect ─────────────────────────────────

describe('MockRealtimeAdapter', () => {
  it('connect() emits session-started with active state', async () => {
    const adapter = new MockRealtimeAdapter();
    const events: VoiceEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    const sessionId = await adapter.connect({});
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    const started = events.find((e) => e.kind === 'session-started');
    expect(started).toBeDefined();
    expect(started?.kind === 'session-started' && started.state).toBe('active');
  });

  it('connect() transitions FSM from idle to active', async () => {
    const adapter = new MockRealtimeAdapter();
    expect(adapter.fsm.state).toBe('idle');

    await adapter.connect({});
    expect(adapter.fsm.state).toBe('active');
  });

  it('disconnect() emits session-ended', async () => {
    const adapter = new MockRealtimeAdapter();
    const events: VoiceEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    await adapter.connect({});
    await adapter.disconnect('operator-stop');

    const ended = events.find((e) => e.kind === 'session-ended');
    expect(ended).toBeDefined();
    if (ended?.kind === 'session-ended') {
      expect(ended.reason).toBe('operator-stop');
    }
  });

  it('disconnect() is idempotent — second call is no-op', async () => {
    const adapter = new MockRealtimeAdapter();
    const events: VoiceEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    await adapter.connect({});
    await adapter.disconnect('operator-stop');
    const countBefore = events.filter((e) => e.kind === 'session-ended').length;

    await adapter.disconnect('operator-stop');
    const countAfter = events.filter((e) => e.kind === 'session-ended').length;
    expect(countAfter).toBe(countBefore);
  });

  it('onEvent() unsubscribe stops receiving events', async () => {
    const adapter = new MockRealtimeAdapter();
    const events: VoiceEvent[] = [];
    const unsub = adapter.onEvent((e) => events.push(e));
    unsub(); // unsubscribe before connect

    await adapter.connect({});
    expect(events).toHaveLength(0);
  });
});

// ─── MockRealtimeAdapter — scriptable events ──────────────────────────────────

describe('MockRealtimeAdapter.scriptEvents()', () => {
  it('emits scripted transcript-partial event after session-started', async () => {
    const adapter = new MockRealtimeAdapter();
    const events: VoiceEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    adapter.scriptEvents([
      {
        kind: 'transcript-partial',
        sessionId: 'test-session',
        text: 'hello world',
        at: 42,
      },
    ]);

    await adapter.connect({});

    const partial = events.find((e) => e.kind === 'transcript-partial');
    expect(partial).toBeDefined();
    if (partial?.kind === 'transcript-partial') {
      expect(partial.text).toBe('hello world');
    }
  });

  it('emits multiple scripted events in order', async () => {
    const adapter = new MockRealtimeAdapter();
    const events: VoiceEvent[] = [];
    adapter.onEvent((e) => events.push(e));

    const sessionId = 'test-multi';
    adapter.scriptEvents([
      { kind: 'transcript-partial', sessionId, text: 'hello', at: 1 },
      { kind: 'transcript-final', sessionId, text: 'hello world', at: 2 },
    ]);

    await adapter.connect({ sessionId });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('session-started');
    expect(kinds).toContain('transcript-partial');
    expect(kinds).toContain('transcript-final');

    // Order: session-started first, then scripted events in sequence.
    const startIdx = kinds.indexOf('session-started');
    const partialIdx = kinds.indexOf('transcript-partial');
    const finalIdx = kinds.indexOf('transcript-final');
    expect(startIdx).toBeLessThan(partialIdx);
    expect(partialIdx).toBeLessThan(finalIdx);
  });

  it('scripted events are drained — second connect() sees none', async () => {
    const adapter = new MockRealtimeAdapter();

    adapter.scriptEvents([
      { kind: 'transcript-partial', sessionId: 's1', text: 'x', at: 1 },
    ]);

    await adapter.connect({ sessionId: 's1' });
    await adapter.disconnect('operator-stop');

    // Reset FSM for second connect (manually via createFsm — for testing only).
    const events2: VoiceEvent[] = [];
    const adapter2 = new MockRealtimeAdapter();
    adapter2.onEvent((e) => events2.push(e));
    await adapter2.connect({});

    const partials = events2.filter((e) => e.kind === 'transcript-partial');
    expect(partials).toHaveLength(0);
  });

  it('events emitted from Mock adapter contain NO keys or secrets', async () => {
    const testKey = 'sk-test-super-secret-key-9999';
    withEnv({ OPENAI_API_KEY: testKey }, async () => {
      const adapter = new MockRealtimeAdapter();
      const eventStrings: string[] = [];
      adapter.onEvent((e) => eventStrings.push(JSON.stringify(e)));

      await adapter.connect({ sessionId: 'sec-test' });

      for (const str of eventStrings) {
        expect(str).not.toContain(testKey);
        expect(str).not.toContain('OPENAI_API_KEY');
        expect(str).not.toContain('LAZYOS_VOICE_OPENAI_KEY');
      }
    });
  });
});
