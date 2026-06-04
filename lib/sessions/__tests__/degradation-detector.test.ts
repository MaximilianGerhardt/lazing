// degradation-detector tests — PURE Funktion, erschöpfende Schwellen-Matrix.
// Das Test-Gate verlangt hier Perfektion (es entscheidet, ob die Operator-
// Session rotiert wird). Kein DB, kein Date.now() im Kern.
//
// Run: NODE_OPTIONS=--experimental-require-module vitest run lib/sessions/__tests__/degradation-detector.test.ts

import { describe, expect, it } from 'vitest';

import {
  assessRotation,
  effectiveAgeMs,
  estimateTokens,
  rotationEnabled,
  rotationPolicyFromEnv,
  DEFAULT_ROTATION_POLICY,
  type RotationPolicy,
  type SessionVitals,
} from '@/lib/sessions/degradation-detector';

const P: RotationPolicy = {
  maxTurns: 40,
  maxTokens: 250_000,
  maxAgeMs: 24 * 60 * 60 * 1000,
  minTurnsForTaskBoundary: 1,
};

const base: SessionVitals = { turnCount: 5, tokenEstimate: 1000, ageMs: 1000, lastResult: 'success' };

describe('assessRotation — no rotation within budgets', () => {
  it('fresh, healthy session does not rotate', () => {
    const d = assessRotation(base, false, P);
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('none');
  });

  it('does NOT rotate on last_result=error (self-heal owns that)', () => {
    const d = assessRotation({ ...base, lastResult: 'error' }, false, P);
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('none');
  });

  it('does NOT rotate on aborted', () => {
    expect(assessRotation({ ...base, lastResult: 'aborted' }, false, P).rotate).toBe(false);
  });

  it('just-below every budget does not rotate', () => {
    const d = assessRotation(
      { turnCount: P.maxTurns - 1, tokenEstimate: P.maxTokens - 1, ageMs: P.maxAgeMs - 1, lastResult: 'success' },
      false,
      P,
    );
    expect(d.rotate).toBe(false);
  });
});

describe('assessRotation — degradation budgets', () => {
  it('rotates at turn budget (>=)', () => {
    const d = assessRotation({ ...base, turnCount: P.maxTurns }, false, P);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('turn-budget');
  });

  it('rotates at token budget (>=)', () => {
    const d = assessRotation({ ...base, tokenEstimate: P.maxTokens }, false, P);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('token-budget');
  });

  it('rotates at age budget (>=)', () => {
    const d = assessRotation({ ...base, ageMs: P.maxAgeMs }, false, P);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('age-budget');
  });

  it('rotates on too_many_turns regardless of counts', () => {
    const d = assessRotation({ turnCount: 1, tokenEstimate: 0, ageMs: 0, lastResult: 'too_many_turns' }, false, P);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('too-many-turns');
  });
});

describe('assessRotation — reason precedence (deterministic)', () => {
  it('too-many-turns beats token/turn/age', () => {
    const d = assessRotation(
      { turnCount: 999, tokenEstimate: 999_999, ageMs: P.maxAgeMs * 10, lastResult: 'too_many_turns' },
      false,
      P,
    );
    expect(d.reason).toBe('too-many-turns');
  });

  it('token beats turn beats age when all exceeded', () => {
    const d = assessRotation(
      { turnCount: P.maxTurns, tokenEstimate: P.maxTokens, ageMs: P.maxAgeMs, lastResult: 'success' },
      false,
      P,
    );
    expect(d.reason).toBe('token-budget');
  });

  it('turn beats age when both exceeded but token is fine', () => {
    const d = assessRotation(
      { turnCount: P.maxTurns, tokenEstimate: 0, ageMs: P.maxAgeMs, lastResult: 'success' },
      false,
      P,
    );
    expect(d.reason).toBe('turn-budget');
  });
});

describe('assessRotation — task boundary', () => {
  it('rotates at a task boundary once the session has worked', () => {
    const d = assessRotation({ ...base, turnCount: 1 }, true, P);
    expect(d.rotate).toBe(true);
    expect(d.reason).toBe('task-boundary');
  });

  it('does NOT rotate a fresh 0-turn session at a task boundary', () => {
    const d = assessRotation({ turnCount: 0, tokenEstimate: 0, ageMs: 0, lastResult: null }, true, P);
    expect(d.rotate).toBe(false);
    expect(d.reason).toBe('none');
  });

  it('task boundary takes precedence over degradation reasons', () => {
    const d = assessRotation(
      { turnCount: P.maxTurns, tokenEstimate: P.maxTokens, ageMs: P.maxAgeMs, lastResult: 'too_many_turns' },
      true,
      P,
    );
    expect(d.reason).toBe('task-boundary');
  });
});

describe('estimateTokens', () => {
  it('≈ chars/4, ceil', () => {
    expect(estimateTokens(4, 0)).toBe(1);
    expect(estimateTokens(0, 4)).toBe(1);
    expect(estimateTokens(3, 0)).toBe(1); // ceil
    expect(estimateTokens(400, 400)).toBe(200);
  });
  it('clamps negatives to 0', () => {
    expect(estimateTokens(-100, -100)).toBe(0);
    expect(estimateTokens(-100, 400)).toBe(100);
  });
});

describe('effectiveAgeMs — CRIT-1 regression (no perpetual age-rotation)', () => {
  const NOW = 1_000_000_000;
  it('ages off created_at when never rotated', () => {
    expect(effectiveAgeMs(NOW - 5000, null, NOW)).toBe(5000);
    expect(effectiveAgeMs(NOW - 5000, undefined, NOW)).toBe(5000);
  });
  it('ages off rotated_at once rotated (the fix: NOT created_at)', () => {
    // created 10 days ago, rotated 1 min ago → age = 1 min, NOT 10 days.
    const created = NOW - 10 * 24 * 3600 * 1000;
    const rotated = NOW - 60_000;
    expect(effectiveAgeMs(created, rotated, NOW)).toBe(60_000);
  });
  it('a just-rotated ancient session is BELOW the 7-day budget → no re-rotation', () => {
    const created = NOW - 261 * 3600 * 1000; // the live 261h session
    const rotated = NOW - 1000; // just rotated
    const age = effectiveAgeMs(created, rotated, NOW);
    expect(age).toBeLessThan(DEFAULT_ROTATION_POLICY.maxAgeMs);
    const d = assessRotation(
      { turnCount: 0, tokenEstimate: 0, ageMs: age, lastResult: null },
      false,
      DEFAULT_ROTATION_POLICY,
    );
    expect(d.rotate).toBe(false); // would have been TRUE with the created_at bug
  });
  it('clamps negative (clock skew) to 0', () => {
    expect(effectiveAgeMs(NOW + 5000, null, NOW)).toBe(0);
  });
});

describe('env policy + kill-switch', () => {
  it('defaults when env unset', () => {
    const p = rotationPolicyFromEnv({});
    expect(p).toEqual(DEFAULT_ROTATION_POLICY);
  });
  it('overrides from env, ignores garbage', () => {
    const p = rotationPolicyFromEnv({ LAZYOS_SESSION_MAX_TURNS: '12', LAZYOS_SESSION_MAX_TOKENS: 'nope', LAZYOS_SESSION_MAX_AGE_MS: '0' });
    expect(p.maxTurns).toBe(12);
    expect(p.maxTokens).toBe(DEFAULT_ROTATION_POLICY.maxTokens); // garbage → default
    expect(p.maxAgeMs).toBe(DEFAULT_ROTATION_POLICY.maxAgeMs); // 0 (not >0) → default
  });
  it('rotation enabled by default; disabled only on "0"', () => {
    expect(rotationEnabled({})).toBe(true);
    expect(rotationEnabled({ LAZYOS_SESSION_ROTATION: '1' })).toBe(true);
    expect(rotationEnabled({ LAZYOS_SESSION_ROTATION: '0' })).toBe(false);
  });
});
