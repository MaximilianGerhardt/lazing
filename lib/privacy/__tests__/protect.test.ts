/**
 * lib/privacy/__tests__/protect.test.ts — the external-call seam contract.
 *
 * Proves the privacy guarantee at the boundary the chat route uses:
 *   - what goes to the cloud is tokenized (no real PII),
 *   - the originals are untouched (persistence/display keep real text),
 *   - what comes back is rehydrated to real values for the user,
 *   - workspace isolation holds,
 *   - OFF is a pure pass-through.
 *
 * Uses the real getDb()/migrations, so env (DB path + key) is set BEFORE the
 * dynamic import (db/client resolves its path once at module load).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

type Protect = typeof import("@/lib/privacy/protect");
let P: Protect;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lazyos-pii-protect-"));
  process.env.LAZYOS_DB_PATH = path.join(dir, "test.db");
  process.env.LAZYOS_TEST_DISABLE_FK = "1";
  process.env.LAZYOS_CREDENTIAL_KEY = "a".repeat(64);
  P = await import("@/lib/privacy/protect");
});

afterEach(() => {
  delete process.env.LAZYOS_PII_VAULT;
  delete process.env.LAZYOS_PII_NER;
});

const on = (): void => {
  process.env.LAZYOS_PII_VAULT = "true";
};

describe("protect seam — OFF", () => {
  it("is a pure pass-through (same array ref, no DB touch)", () => {
    delete process.env.LAZYOS_PII_VAULT;
    const msgs = [{ role: "user", content: "mail alice@example.com" }];
    expect(P.piiVaultEnabled()).toBe(false);
    expect(P.tokenizeMessages("ws", msgs)).toBe(msgs); // identity
    expect(P.rehydrate("ws", "alice@example.com")).toBe("alice@example.com");
  });
});

describe("protect seam — ON", () => {
  it("cloud sees tokens; originals untouched; reply rehydrated (round-trip)", () => {
    on();
    expect(P.piiVaultEnabled()).toBe(true);
    const msgs = [
      { role: "user", content: "email alice@example.com and IBAN DE89370400440532013000" },
    ];
    const cloudBound = P.tokenizeMessages("ws", msgs);

    // What the external engine receives — no real PII:
    expect(cloudBound[0].content).not.toContain("alice@example.com");
    expect(cloudBound[0].content).not.toContain("DE89370400440532013000");
    expect(cloudBound[0].content).toMatch(/\[\[EMAIL_1\]\]/);
    expect(cloudBound[0].content).toMatch(/\[\[IBAN_1\]\]/);

    // Originals are NOT mutated (persistence/display use these):
    expect(msgs[0].content).toContain("alice@example.com");

    // The model echoes the tokens back → the user sees the real values:
    expect(P.rehydrate("ws", "I sent it to [[EMAIL_1]] (acct [[IBAN_1]]).")).toBe(
      "I sent it to alice@example.com (acct DE89370400440532013000).",
    );
  });

  it("is workspace-isolated — another workspace cannot rehydrate the token", () => {
    on();
    P.tokenizeMessages("ws-a", [{ role: "user", content: "carol@example.com" }]);
    expect(P.rehydrate("ws-b", "[[EMAIL_1]]")).toBe("[[EMAIL_1]]");
  });

  it("async tokenizer equals the deterministic sync one when NER is off", async () => {
    on();
    delete process.env.LAZYOS_PII_NER;
    const a = P.tokenizeMessages("ws-async", [{ role: "user", content: "mail dave@example.com" }]);
    const b = await P.tokenizeMessagesAsync("ws-async", [
      { role: "user", content: "mail dave@example.com" },
    ]);
    expect(b[0].content).toBe(a[0].content);
    expect(b[0].content).toMatch(/\[\[EMAIL_1\]\]/);
  });
});

type ChatEngine = import("@/lib/llm/engines/types").ChatEngine;

/** A fake engine that records what it received and echoes it back. */
function fakeEngine(id: ChatEngine["id"]): {
  engine: ChatEngine;
  received: () => string | null;
} {
  let seen: string | null = null;
  const engine: ChatEngine = {
    id,
    detect: async () => ({ engine: id, available: true, reason: "", probeMs: 0 }),
    chat: async (req) => {
      seen = req.messages.map((m) => m.content).join(" | ");
      // Echo the (token-bearing) content back so the caller can prove rehydration.
      return {
        engine: id,
        model: "fake",
        text: `reply → ${req.messages[req.messages.length - 1]?.content ?? ""}`,
        latencyMs: 1,
      };
    },
  };
  return { engine, received: () => seen };
}

describe("protectEngine — the cloud-egress boundary wrapper", () => {
  it("CLOUD engine: tokenizes what the engine receives, rehydrates the reply", async () => {
    on();
    const f = fakeEngine("claude-cli");
    const wrapped = P.protectEngine("ws-pe", f.engine);
    expect(wrapped).not.toBe(f.engine); // a real wrapper, not the same object

    const res = await wrapped.chat({
      messages: [{ role: "user", content: "mail erin@example.com please" }],
    });

    // The cloud engine only ever saw a token, never the real address:
    expect(f.received()).not.toContain("erin@example.com");
    expect(f.received()).toMatch(/\[\[EMAIL_1\]\]/);
    // The caller gets the real value back (reply was rehydrated locally):
    expect(res.text).toContain("erin@example.com");
    expect(res.text).not.toMatch(/\[\[EMAIL_1\]\]/);
  });

  it("LOCAL ollama engine: returned untouched (identity — never tokenized)", () => {
    on();
    const f = fakeEngine("ollama");
    expect(P.protectEngine("ws-pe", f.engine)).toBe(f.engine);
  });

  it("vault OFF or no workspace scope: returned untouched (identity)", () => {
    const f = fakeEngine("claude-cli");
    delete process.env.LAZYOS_PII_VAULT;
    expect(P.protectEngine("ws-pe", f.engine)).toBe(f.engine); // off → identity
    on();
    expect(P.protectEngine("", f.engine)).toBe(f.engine); // no scope → identity
  });

  it("null engine (no engine available) passes through as null", () => {
    on();
    expect(P.protectEngine("ws-pe", null)).toBeNull();
  });
});
