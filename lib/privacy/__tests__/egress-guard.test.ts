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
    const cloudDirect = /getEngine\(\s*["'](?:claude-cli|grok)["']\s*\)/;

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

  it("every orchestrate({...}) call site passes a workspaceId (or is allow-listed)", () => {
    // The leak class roast #5 found: orchestrate() is itself a cloud-egress
    // boundary (it calls getEngine(req.mode).chat()), reached dynamically via
    // `mode`. A call that omits `workspaceId` runs the racers on raw PII. Every
    // call site must pass a scope — unless it pre-tokenizes (main chat path) or
    // carries no user PII (dev fixtures).
    // `await orchestrate({` — the actual call shape. The `await` prefix excludes
    // doc-comment references like `orchestrate({mode:'claude-cli'})`.
    const ORCH_CALL = /await\s+orchestrate\(\s*\{/g;
    const ALLOW = new Map<string, string>([
      [
        "app/api/chat/stream/route.ts",
        "main chat path pre-tokenizes with the NER layer (tokenizeMessagesAsync) + rehydrates",
      ],
      [
        "lib/skills/benchmark.ts",
        "developer skill-eval fixtures — no user/customer PII",
      ],
    ]);

    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      if (rel(f) === "lib/llm/orchestrator.ts") continue; // the definition itself
      if (ALLOW.has(rel(f))) continue;
      // Strip `//` line comments (replace-with-empty preserves newlines → line
      // numbers stay correct) so inline comments inside a call don't bloat the
      // look-ahead window past the workspaceId field.
      const src = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "");
      let m: RegExpExecArray | null;
      ORCH_CALL.lastIndex = 0;
      while ((m = ORCH_CALL.exec(src)) !== null) {
        // The call's argument object — look ahead far enough to cover a
        // multi-line { mode, messages, …, workspaceId } literal.
        const window = src.slice(m.index, m.index + 600);
        if (!window.includes("workspaceId")) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${rel(f)}:${line}`);
        }
      }
    }

    expect(
      offenders,
      "These orchestrate({...}) calls do not pass a workspaceId — the racers would " +
        "see raw PII. Add `workspaceId` so orchestrate() tokenizes/rehydrates, or " +
        "add a documented allow-list entry (pre-tokenized / no-PII).",
    ).toEqual([]);
  });

  it("chatWithFallback() has no unprotected call site", () => {
    // chatWithFallback (lib/llm/engines/index.ts) fans out to claude-cli (cloud)
    // and tokenizes nothing — and it slips past the other three checks (it uses
    // pickEngine(selection, skip), not the ['codex-cli'] literal, and is neither a
    // getEngine('claude-cli').chat nor an orchestrate() call). It has ZERO callers
    // today; this guard keeps it that way unless a future caller routes its
    // request through the vault first (tokenize the messages) or is allow-listed.
    const offenders = sourceFiles()
      .filter((f) => rel(f) !== "lib/llm/engines/index.ts") // the definition itself
      .filter((f) => {
        const src = readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "");
        return /\bchatWithFallback\s*\(/.test(src) && !src.includes("tokeniz");
      })
      .map(rel);

    expect(
      offenders,
      "These files call chatWithFallback() — an unwrapped cloud-egress helper — " +
        "without tokenizing first. Tokenize the request messages (tokenizeMessages) " +
        "before the call, or route through protectEngine/orchestrate instead.",
    ).toEqual([]);
  });
});
