/**
 * lib/skills/benchmark.ts — TS-native, engine-agnostic skill benchmark.
 *
 * Owner: benchmarks "that we could run ourselves". Instead of shelling out to the
 * fragile python skill-creator (pyyaml/py3.8+/own harness), this
 * benchmark measures with laz.ing's OWN engines (orchestrate → claude/codex/ollama):
 *
 *   With-skill vs baseline (research §5, benchmark 1):
 *     per task once WITHOUT the skill (baseline) and once WITH the injected
 *     SKILL.md body. A lexical grader (deterministic, no extra LLM) checks
 *     assertions → pass-rate delta + latency. Measurably proves whether a skill helps.
 *
 * Pure parts (gradeOutput, aggregate) are deterministic + tested; the
 * runner calls orchestrate (engine-agnostic, best-effort).
 */

export interface Assertion {
  /** Output MUST contain this substring (case-insensitive). */
  contains?: string;
  /** Output MUST match this regex. */
  matches?: string;
  /** Output must NOT contain this substring. */
  notContains?: string;
}

export interface BenchTask {
  prompt: string;
  assertions: Assertion[];
}

export interface BenchEvalSet {
  /** Skill ID (in the store). */
  skill: string;
  tasks: BenchTask[];
}

export interface GradeResult {
  passed: number;
  total: number;
  ok: boolean;
}

/** Deterministic lexical grader — no LLM. */
export function gradeOutput(output: string, assertions: Assertion[]): GradeResult {
  const text = output ?? '';
  const low = text.toLowerCase();
  let passed = 0;
  for (const a of assertions) {
    let ok = true;
    if (a.contains !== undefined) ok &&= low.includes(a.contains.toLowerCase());
    if (a.notContains !== undefined) ok &&= !low.includes(a.notContains.toLowerCase());
    if (a.matches !== undefined) {
      try {
        ok &&= new RegExp(a.matches, 'i').test(text);
      } catch {
        ok = false;
      }
    }
    if (ok) passed += 1;
  }
  const total = assertions.length;
  return { passed, total, ok: total > 0 && passed === total };
}

export interface VariantStats {
  /** Fraction of tasks whose ALL assertions were met. */
  passRate: number;
  /** Average met assertions (0..1). */
  assertionRate: number;
  meanLatencyMs: number;
  tasks: number;
}

export interface Scorecard {
  skill: string;
  baseline: VariantStats;
  withSkill: VariantStats;
  /** withSkill.passRate − baseline.passRate (positive = skill helps). */
  passRateDelta: number;
  assertionRateDelta: number;
}

interface RawRun {
  passed: number;
  total: number;
  ok: boolean;
  latencyMs: number;
}

/** Pure aggregation of the raw runs of a variant. */
export function aggregateVariant(runs: RawRun[]): VariantStats {
  const n = runs.length;
  if (n === 0) return { passRate: 0, assertionRate: 0, meanLatencyMs: 0, tasks: 0 };
  const passRate = runs.filter((r) => r.ok).length / n;
  const assertionRate =
    runs.reduce((acc, r) => acc + (r.total > 0 ? r.passed / r.total : 0), 0) / n;
  const meanLatencyMs = Math.round(runs.reduce((acc, r) => acc + r.latencyMs, 0) / n);
  return { passRate, assertionRate, meanLatencyMs, tasks: n };
}

/** Scorecard from baseline + with-skill runs. */
export function buildScorecard(skill: string, baseline: RawRun[], withSkill: RawRun[]): Scorecard {
  const b = aggregateVariant(baseline);
  const w = aggregateVariant(withSkill);
  return {
    skill,
    baseline: b,
    withSkill: w,
    passRateDelta: Number((w.passRate - b.passRate).toFixed(3)),
    assertionRateDelta: Number((w.assertionRate - b.assertionRate).toFixed(3)),
  };
}

/**
 * Runs the benchmark (orchestrate, engine-agnostic). Per task: baseline
 * (without skill) + with-skill (SKILL.md body injected as a system prompt). Grading
 * via gradeOutput. Best-effort — an engine exception counts as a failure.
 *
 * @param mode  orchestrate mode (default 'claude-cli'); 'ollama'/'codex-cli'/'parallel-all' possible.
 */
export async function runBenchmark(
  evalSet: BenchEvalSet,
  opts: {
    mode?: 'claude-cli' | 'codex-cli' | 'ollama';
    timeoutMs?: number;
    /**
     * Clean A/B (default true): since claude/codex load the skill NATIVELY from their
     * skill directory, the baseline would otherwise also see it → no
     * delta. With cleanBaseline the skill symlink is temporarily removed for the
     * BASELINE run and reset afterwards (best-effort, fail-soft).
     * Irrelevant for mode:'ollama' (no native loading).
     */
    cleanBaseline?: boolean;
  } = {},
): Promise<Scorecard> {
  const mode = opts.mode ?? 'claude-cli';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const cleanBaseline = opts.cleanBaseline ?? true;

  // Read the skill body (for the with-skill injection).
  const { getSkillsDir } = await import('./store');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  let skillBody = '';
  try {
    const raw = readFileSync(join(getSkillsDir(), evalSet.skill, 'SKILL.md'), 'utf8');
    skillBody = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
  } catch {
    /* without a body the with-variant runs = baseline */
  }

  const { orchestrate } = await import('@/lib/llm/orchestrator');

  const exec = async (prompt: string, assertions: Assertion[], injectBody: boolean): Promise<RawRun> => {
    const t0 = Date.now();
    const messages =
      injectBody && skillBody
        ? [
            { role: 'system' as const, content: skillBody },
            { role: 'user' as const, content: prompt },
          ]
        : [{ role: 'user' as const, content: prompt }];
    let text = '';
    try {
      const res = await orchestrate({ mode, messages, parallelTimeoutMs: timeoutMs });
      text = res.text ?? '';
    } catch {
      text = '';
    }
    const g = gradeOutput(text, assertions);
    return { passed: g.passed, total: g.total, ok: g.ok, latencyMs: Date.now() - t0 };
  };

  const baseline: RawRun[] = [];
  const withSkill: RawRun[] = [];

  // Phase 1 — BASELINE: for a clean A/B, temporarily remove the natively loaded skill
  // from the engine directory (claude/codex), then restore it
  // afterwards. Without native injection (body NOT injected) = true baseline.
  let restore: (() => void) | null = null;
  if (cleanBaseline && mode !== 'ollama') {
    restore = await unsyncSkillForBaseline(evalSet.skill, mode);
  }
  try {
    for (const task of evalSet.tasks) baseline.push(await exec(task.prompt, task.assertions, false));
  } finally {
    if (restore) restore();
  }

  // Phase 2 — WITH-SKILL: skill natively present again + body injected.
  for (const task of evalSet.tasks) withSkill.push(await exec(task.prompt, task.assertions, true));

  return buildScorecard(evalSet.skill, baseline, withSkill);
}

/**
 * Temporarily removes the (laz.ing-managed) skill symlink from the engine dir
 * and returns a restore function. Best-effort, fail-soft.
 */
async function unsyncSkillForBaseline(
  skillId: string,
  mode: 'claude-cli' | 'codex-cli' | 'ollama',
): Promise<() => void> {
  if (mode === 'ollama') return () => {};
  const { engineSkillDir } = await import('./sync');
  const { getSkillsDir } = await import('./store');
  const { lstatSync, readlinkSync, rmSync, symlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = engineSkillDir(mode);
  const target = join(dir, skillId);
  const storeDir = getSkillsDir();
  let wasLink = false;
  try {
    if (lstatSync(target).isSymbolicLink() && readlinkSync(target).startsWith(storeDir)) {
      rmSync(target, { force: true });
      wasLink = true;
    }
  } catch {
    /* not present → nothing to do */
  }
  return () => {
    if (!wasLink) return;
    try {
      symlinkSync(join(storeDir, skillId), target, 'dir');
    } catch {
      /* restore best-effort */
    }
  };
}
