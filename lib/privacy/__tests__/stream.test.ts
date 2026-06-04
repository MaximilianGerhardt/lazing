/**
 * lib/privacy/__tests__/stream.test.ts — streaming detokenization.
 *
 * Verifies that a [[TYPE_n]] placeholder split across stream chunks / SSE token
 * frames is buffered and resolved correctly (the user never sees a half-rewritten
 * token), and that non-token SSE frames pass through untouched.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

process.env.LAZYOS_CREDENTIAL_KEY =
  process.env.LAZYOS_CREDENTIAL_KEY ?? "a".repeat(64);

import { tokenizeText } from "@/lib/privacy/pii-vault";
import { makeStreamDetokenizer } from "@/lib/privacy/stream-detokenizer";
import { makeSseDetokenizer } from "@/lib/privacy/sse-detokenize";

type RawDb = import("better-sqlite3").Database;

const mig = (f: string): string =>
  readFileSync(path.join(process.cwd(), "db", "migrations", f), "utf8");

function freshDb(): RawDb {
  const raw = new Database(":memory:");
  raw.exec(mig("0131_pii_vault.sql"));
  return raw;
}

describe("makeStreamDetokenizer", () => {
  let raw: RawDb;
  let token: string;
  beforeEach(() => {
    process.env.LAZYOS_CREDENTIAL_KEY = "a".repeat(64);
    raw = freshDb();
    token = tokenizeText(raw, "ws", "mail alice@example.com").tokens[0]; // [[EMAIL_1]]
  });

  it("reassembles a token split across three chunks", () => {
    const d = makeStreamDetokenizer(raw, "ws");
    let out = d.push("Reply: " + token.slice(0, 5)); // "Reply: [[EMA"
    out += d.push(token.slice(5, 8)); // "IL_"
    out += d.push(token.slice(8) + " ok"); // "1]] ok"
    out += d.flush();
    expect(out).toBe("Reply: alice@example.com ok");
  });

  it("never emits a half-rewritten placeholder mid-stream", () => {
    const d = makeStreamDetokenizer(raw, "ws");
    const a = d.push("x " + token.slice(0, 6)); // partial token must be held
    expect(a).toBe("x "); // only the safe prefix is emitted
    expect(a).not.toContain("[[");
    const b = d.push(token.slice(6)) + d.flush();
    expect(a + b).toBe("x alice@example.com");
  });
});

describe("makeSseDetokenizer", () => {
  let raw: RawDb;
  let token: string;
  const dec = new TextDecoder();
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  beforeEach(() => {
    process.env.LAZYOS_CREDENTIAL_KEY = "a".repeat(64);
    raw = freshDb();
    token = tokenizeText(raw, "ws", "mail bob@example.com").tokens[0];
  });

  it("detokenizes token-frame deltas (split across frames) and passes others through", () => {
    const s = makeSseDetokenizer(raw, "ws");
    let out = "";
    out += dec.decode(s.push(enc(`event: ready\ndata: {"sessionId":null}\n\n`)));
    out += dec.decode(
      s.push(enc(`event: token\ndata: ${JSON.stringify({ delta: "hi " + token.slice(0, 5) })}\n\n`)),
    );
    out += dec.decode(
      s.push(enc(`event: token\ndata: ${JSON.stringify({ delta: token.slice(5) + "!" })}\n\n`)),
    );
    out += dec.decode(s.push(enc(`event: done\ndata: {"is_error":false}\n\n`)));
    out += dec.decode(s.flush());

    expect(out).toContain("event: ready");
    expect(out).toContain("event: done");
    const deltas = [...out.matchAll(/event: token\ndata: (\{[^\n]*\})/g)]
      .map((m) => (JSON.parse(m[1]) as { delta: string }).delta)
      .join("");
    expect(deltas).toBe("hi bob@example.com!");
    expect(out).not.toContain("[[EMAIL"); // no token ever surfaced to the client
  });
});
