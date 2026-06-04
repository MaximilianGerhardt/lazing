// Plan template — perf-investigation (5 steps).
//
// BACKPORT-03 von Lazing-V2 (2026-05-23). Bytewise identisch zur V2-Quelle.
//
// Profile-first, measure-twice loop. The walker should NOT propose
// optimisations before a profile lands — this template encodes that
// discipline as step ordering.

import type { PlanTemplate } from './index';

export const PERF_INVESTIGATION_REGEX =
  /\b(perf(?:ormance)?|profile|profiling|optimi[sz]e|optimi[sz]ation|slow|langsam|bottleneck|engpass|latency|latenz|throughput|durchsatz)\b/i;

export const perfInvestigationTemplate: PlanTemplate = {
  id: 'perf-investigation',
  label: 'Perf (profile → hypothesise → bench → optimise → verify)',
  estimatedComplexity: 'L',
  steps: [
    {
      index: 1,
      title: 'Profile the hot path under realistic load',
      rationale:
        'Without a profile every "optimisation" is a guess; capture wall-clock + flamegraph data BEFORE touching code.',
      subagentRole: 'tester',
    },
    {
      index: 2,
      title: 'Form a short list of hypotheses ranked by expected gain',
      rationale:
        'Convert the profile into 2–4 concrete hypotheses; rank by expected speedup × implementation effort so we tackle the highest-leverage one first.',
      subagentRole: 'architect',
    },
    {
      index: 3,
      title: 'Build a micro-benchmark for the top hypothesis',
      rationale:
        'Pin the smallest reproducible workload that exercises the suspected bottleneck so optimisations can be measured in isolation.',
      subagentRole: 'tester',
    },
    {
      index: 4,
      title: 'Implement the optimisation behind the micro-bench',
      rationale:
        'Land the change with both old + new code paths gated by a flag; the bench picks the winner deterministically.',
      subagentRole: 'coder',
    },
    {
      index: 5,
      title: 'Re-profile + verify the gain on the realistic load',
      rationale:
        'Run the original profile harness; assert the wall-clock improvement matches the bench; document the result for the next session.',
      subagentRole: 'reviewer',
    },
  ],
};
