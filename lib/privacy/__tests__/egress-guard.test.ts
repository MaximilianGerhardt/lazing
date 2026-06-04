/**
 * lib/privacy/__tests__/egress-guard.test.ts — deterministic source guard (N6).
 *
 * Four adversarial reviews of the PII vault kept finding the SAME leak class:
 * a caller picks an engine with `pickEngine(selection, ['codex-cli'])` — which
 * still resolves to **claude-cli (a cloud engine)** — and calls `engine.chat()`
 * with a raw, un-tokenized prompt. This test makes that class a build failure:
 * any source file that uses the codex-excluded pickEngine pattern, or calls a
 * cloud engine directly, MUST route through `protectEngine` (the boundary
 * wrapper) — or be explicitly allow-listed with a documented reason.
 *
 * It is intentionally a grep, not a type rule: the leak is "forgot to wrap", and
 * only a source-level check catches a brand-new call site the type system is
 * perfectly happy with.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC_DIRS = ["app", "lib", "server"];

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of SRC_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(path.join(ROOT, dir), { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const rel of entries) {
      const full = path.join(ROOT, dir, rel);
      if (!full.endsWith(".ts") && !full.endsWith(".tsx")) continue;
      if (full.includes("__tests__") || full.endsWith(".test.ts") || full.endsWith(".test.tsx")) {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string): string => path.relative(ROOT, f);

describe("PII vault — cloud-egress source guard (N6)", () => {
  it("every pickEngine(codex-excluded) site wraps the engine with protectEngine", () => {
    // The exact signature roast #4 kept finding: pickEngine(sel, ['codex-cli']).
    const codexExcluded = /pickEngine\([^)]*\[\s*["']codex-cli["']\s*\]/;
    const offenders = sourceFiles()
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return codexExcluded.test(src) && !src.includes("protectEngine(");
      })
      .map(rel);

    expect(
      offenders,
      `These files pick a codex-excluded engine (→ claude-cli, cloud) but never wrap ` +
        `it with protectEngine — raw PII can reach the cloud. Wrap the pickEngine(...) ` +
        `result: const engine = protectEngine(workspaceId, pickEngine(selection, ['codex-cli'])).`,
    ).toEqual([]);
  });

  it("direct getEngine('claude-cli').chat sites are protected or explicitly allow-listed", () => {
    // Files that call the cloud engine directly AND are safe by another mechanism.
    // Each entry must stay justified; removing the safety there must drop it here.
    const ALLOW = new Map<string, string>([
      [
        "lib/llm/chat-consensus.ts",
        "synthesis runs on the orchestrator's already-tokenized messages + responses",
      ],
      [
        "server/agents/ultracoding-orchestrator.ts",
        "tokenizes the task at entry + the diffs before review (C-NEW-1/C-NEW-2)",
      ],
    ]);
    const cloudDirect = /getEngine\(\s*["']claude-cli["']\s*\)/;

    const offenders = sourceFiles()
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        if (!cloudDirect.test(src) || !src.includes(".chat(")) return false;
        if (src.includes("protectEngine(")) return false; // wrapped → safe
        return !ALLOW.has(rel(f)); // otherwise must be allow-listed
      })
      .map(rel);

    expect(
      offenders,
      "These files call getEngine('claude-cli').chat() directly without protectEngine " +
        "and are not allow-listed. Wrap with protectEngine(workspaceId, …) or add a " +
        "documented allow-list entry explaining why the egress is already tokenized.",
    ).toEqual([]);
  });
});
