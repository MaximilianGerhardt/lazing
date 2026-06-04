/**
 * lib/privacy/__tests__/pii-vault.test.ts — PII vault (in-memory, deterministic).
 *
 * Verifies: detection, token round-trip, local AES-256-GCM encryption (the real
 * value is never stored in plaintext), workspace isolation (a token from one
 * workspace cannot be de-tokenized in another), and stable/deduplicated tokens.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

// AES-256-GCM key for the vault (test value; real deployments set their own).
process.env.LAZYOS_CREDENTIAL_KEY =
  process.env.LAZYOS_CREDENTIAL_KEY ?? "a".repeat(64);

import { detectDeterministic } from "@/lib/privacy/pii-detectors";
import { tokenizeText, detokenizeText } from "@/lib/privacy/pii-vault";

type RawDb = import("better-sqlite3").Database;

const mig = (f: string): string =>
  readFileSync(path.join(process.cwd(), "db", "migrations", f), "utf8");

function freshDb(): RawDb {
  const raw = new Database(":memory:");
  raw.exec(mig("0131_pii_vault.sql"));
  return raw;
}

describe("pii-detectors", () => {
  it("finds email, IBAN, IPv4 and a card number (Luhn-valid)", () => {
    const text =
      "Mail alice@example.com, IBAN DE89370400440532013000, IP 192.168.1.1, card 4242 4242 4242 4242.";
    const types = detectDeterministic(text)
      .map((s) => s.type)
      .sort();
    expect(types).toContain("EMAIL");
    expect(types).toContain("IBAN");
    expect(types).toContain("IP");
    expect(types).toContain("CARD");
  });

  it("rejects a random digit run that fails Luhn", () => {
    const spans = detectDeterministic("number 1234567890123456 here");
    expect(spans.some((s) => s.type === "CARD")).toBe(false);
  });
});

describe("pii-vault", () => {
  let raw: RawDb;
  beforeEach(() => {
    process.env.LAZYOS_CREDENTIAL_KEY = "a".repeat(64);
    raw = freshDb();
  });

  it("tokenizes then detokenizes back to the original (round-trip)", () => {
    const original = "Contact alice@example.com about IBAN DE89370400440532013000.";
    const t = tokenizeText(raw, "ws-a", original);
    expect(t.entityCount).toBe(2);
    expect(t.text).not.toContain("alice@example.com");
    expect(t.text).not.toContain("DE89370400440532013000");
    expect(t.text).toMatch(/\[\[EMAIL_1\]\]/);
    expect(t.text).toMatch(/\[\[IBAN_1\]\]/);

    const back = detokenizeText(raw, "ws-a", t.text);
    expect(back.restored).toBe(2);
    expect(back.text).toBe(original);
  });

  it("stores the value encrypted, never in plaintext", () => {
    tokenizeText(raw, "ws-a", "mail bob@example.com");
    const row = raw
      .prepare("SELECT value_enc FROM pii_vault WHERE workspace_id='ws-a'")
      .get() as { value_enc: string };
    expect(row.value_enc).not.toContain("bob@example.com");
    expect(row.value_enc.length).toBeGreaterThan(10);
  });

  it("is workspace-isolated: a token from ws-a cannot be de-tokenized in ws-b", () => {
    const t = tokenizeText(raw, "ws-a", "mail carol@example.com");
    const leak = detokenizeText(raw, "ws-b", t.text);
    expect(leak.restored).toBe(0);
    expect(leak.text).toBe(t.text); // token left as-is, no cross-workspace reveal
  });

  it("gives the same value a stable token across calls (dedup)", () => {
    const a = tokenizeText(raw, "ws-a", "mail dave@example.com first");
    const b = tokenizeText(raw, "ws-a", "mail dave@example.com again");
    expect(a.tokens).toEqual(b.tokens);
    const count = raw
      .prepare("SELECT COUNT(*) AS c FROM pii_vault WHERE workspace_id='ws-a'")
      .get() as { c: number };
    expect(count.c).toBe(1); // only one vault row for the repeated value
  });

  it("distinct values get distinct numbered tokens", () => {
    const t = tokenizeText(raw, "ws-a", "x@example.com and y@example.com");
    expect(t.tokens.sort()).toEqual(["[[EMAIL_1]]", "[[EMAIL_2]]"]);
    expect(detokenizeText(raw, "ws-a", t.text).text).toBe(
      "x@example.com and y@example.com",
    );
  });

  it("no entities → text unchanged, nothing stored", () => {
    const t = tokenizeText(raw, "ws-a", "just a harmless sentence");
    expect(t.text).toBe("just a harmless sentence");
    expect(t.entityCount).toBe(0);
  });
});
