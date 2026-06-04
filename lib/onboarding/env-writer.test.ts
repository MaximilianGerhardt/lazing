/**
 * Unit tests for the append-only .env.local writer (Track B, B3/B6).
 *
 * Focus: append on absence, never-clobber on presence, allowlist enforcement,
 * and verbatim value preservation (no truncation — N1).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  WRITABLE_ENV_KEYS,
  appendEnvVar,
  isWritableEnvKey,
} from "./env-writer";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "lazyos-envwriter-"));
const envFile = path.join(tmpRoot, ".env.local");

const savedEnvFile = process.env.LAZYOS_ENV_FILE;
const savedOpenAi = process.env.OPENAI_API_KEY;
const savedAnthropic = process.env.ANTHROPIC_API_KEY;

beforeAll(() => {
  process.env.LAZYOS_ENV_FILE = envFile;
});

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  if (existsSync(envFile)) rmSync(envFile);
});

afterAll(() => {
  if (savedEnvFile === undefined) delete process.env.LAZYOS_ENV_FILE;
  else process.env.LAZYOS_ENV_FILE = savedEnvFile;
  if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAi;
  if (savedAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropic;
});

describe("allowlist", () => {
  it("contains the provider keys and the PII vault toggles", () => {
    expect([...WRITABLE_ENV_KEYS]).toEqual([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "LAZYOS_PII_VAULT",
      "LAZYOS_PII_NER",
    ]);
  });

  it("rejects non-allowlisted keys", () => {
    expect(isWritableEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isWritableEnvKey("LAZYOS_AUTH_SECRET")).toBe(false);
    expect(() => appendEnvVar("PATH", "/evil")).toThrow(/non-allowlisted/);
  });

  it("rejects an empty value", () => {
    expect(() => appendEnvVar("OPENAI_API_KEY", "   ")).toThrow(/empty value/);
  });
});

describe("append on absence", () => {
  it("creates the file and appends the key verbatim", () => {
    const longKey = "sk-" + "a".repeat(120); // long value must survive intact (N1)
    const r = appendEnvVar("OPENAI_API_KEY", longKey);
    expect(r.outcome).toBe("appended");
    const contents = readFileSync(envFile, "utf8");
    expect(contents).toContain(`OPENAI_API_KEY=${longKey}`);
    // Reflected into the live process env for immediate use.
    expect(process.env.OPENAI_API_KEY).toBe(longKey);
  });
});

describe("never clobber on presence", () => {
  it("leaves an existing key untouched and reports exists", () => {
    const original = "sk-original-value-keep-me";
    writeFileSync(envFile, `OPENAI_API_KEY=${original}\n`);

    const r = appendEnvVar("OPENAI_API_KEY", "sk-new-value-should-be-ignored");
    expect(r.outcome).toBe("exists");

    const contents = readFileSync(envFile, "utf8");
    expect(contents).toContain(`OPENAI_API_KEY=${original}`);
    expect(contents).not.toContain("sk-new-value-should-be-ignored");
    const count = (contents.match(/^OPENAI_API_KEY=/gm) ?? []).length;
    expect(count).toBe(1);
  });

  it("strips newlines from the appended value", () => {
    const r = appendEnvVar("ANTHROPIC_API_KEY", "sk-ant-\nline2\r\nline3");
    expect(r.outcome).toBe("appended");
    const contents = readFileSync(envFile, "utf8");
    expect(contents).toContain("ANTHROPIC_API_KEY=sk-ant-line2line3");
  });
});
