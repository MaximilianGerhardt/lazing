import { describe, it, expect } from 'vitest';
import { resourcePool } from '@/lib/agents/resource-pool';

describe('resource-pool concurrency budget (SLOT-DECOUPLING smoke)', () => {
  it('exposes separated, sane class budgets', () => {
    const cb = resourcePool.getConcurrencyBudget();
    expect(cb.heavyOllama).toBe(2);            // N11: max 2 heavy Ollama (unchanged)
    expect(cb.spawnConcurrency).toBe(5);       // == worktree cap MAX_RUN_WORKTREES
    expect(cb.textConcurrency).toBeGreaterThanOrEqual(1);
    expect(cb.textConcurrency).toBeLessThanOrEqual(6); // cores, capped at 6
    // heavy-engine pool unchanged: N11 2/2/1.
    const b = resourcePool.getBudget();
    expect(b.heavyTotal).toBe(2);
    expect(b.perKind['ollama-heavy']).toBe(1);
  });
});
