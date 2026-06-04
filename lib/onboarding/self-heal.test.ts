/**
 * Unit tests for the safe self-healing preflight (Track B, B1/B6).
 *
 * Focus: idempotency (a second run reports `noop`), non-destructiveness
 * (env-secrets appends and never clobbers an existing key), and the
 * allowlist guard. Network-dependent healers (ollama) are not exercised
 * here — the route test covers the unknown-id 400 path.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SELF_HEAL_IDS,
  isSelfHealId,
  lazyosDir,
  runHealer,
} from "./self-heal";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "lazyos-selfheal-"));
const fakeHome = path.join(tmpRoot, "home");
const envFile = path.join(tmpRoot, ".env.local");

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeAll(() => {
  setEnv("LAZYOS_HOME_DIR", path.join(fakeHome, ".lazyos"));
  setEnv("LAZYOS_ENV_FILE", envFile);
  // Force Ollama "down" so the ollama healer is a clean skip in any test that
  // reaches it (none here directly, but keeps the env hermetic).
  setEnv("LAZYOS_OLLAMA_URL", "http://127.0.0.1:1");
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) setEnv(k, v);
});

describe("SELF_HEAL_IDS allowlist", () => {
  it("contains the four safe healers and rejects unknown ids", () => {
    expect([...SELF_HEAL_IDS]).toEqual([
      "db-migrate",
      "lazyos-dir",
      "env-secrets",
      "ollama-model",
    ]);
    expect(isSelfHealId("db-migrate")).toBe(true);
    expect(isSelfHealId("rm-rf")).toBe(false);
    expect(isSelfHealId("kill-port")).toBe(false);
  });
});

describe("lazyos-dir healer", () => {
  it("creates ~/.lazyos at mode 700, then is idempotent (noop)", async () => {
    const dir = lazyosDir();
    expect(existsSync(dir)).toBe(false);

    const first = await runHealer("lazyos-dir");
    expect(first.outcome).toBe("fixed");
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const second = await runHealer("lazyos-dir");
    expect(second.outcome).toBe("noop");
  });
});

describe("env-secrets healer", () => {
  it("appends missing secrets and is idempotent", async () => {
    // Start from a file that has neither secret + ensure the shell env is empty.
    writeFileSync(envFile, "# existing file\nLAZYOS_OWNER_EMAIL=owner@example.com\n");
    setEnv("LAZYOS_CREDENTIAL_KEY", undefined);
    setEnv("LAZYOS_AUTH_SECRET", undefined);

    const first = await runHealer("env-secrets");
    expect(first.outcome).toBe("fixed");
    const after = readFileSync(envFile, "utf8");
    expect(after).toMatch(/^LAZYOS_CREDENTIAL_KEY=[0-9a-f]{64}$/m);
    expect(after).toMatch(/^LAZYOS_AUTH_SECRET=[0-9a-f]{64}$/m);
    // The pre-existing line must be untouched.
    expect(after).toMatch(/^LAZYOS_OWNER_EMAIL=owner@example\.com$/m);

    // Second run: keys now exist in the FILE, so it must not append duplicates.
    const second = await runHealer("env-secrets");
    expect(second.outcome).toBe("noop");
    const afterSecond = readFileSync(envFile, "utf8");
    const credCount = (afterSecond.match(/^LAZYOS_CREDENTIAL_KEY=/gm) ?? []).length;
    const authCount = (afterSecond.match(/^LAZYOS_AUTH_SECRET=/gm) ?? []).length;
    expect(credCount).toBe(1);
    expect(authCount).toBe(1);
  });

  it("never clobbers an existing secret line", async () => {
    const existingKey = "deadbeef".repeat(8); // 64 hex chars
    writeFileSync(envFile, `LAZYOS_CREDENTIAL_KEY=${existingKey}\n`);
    setEnv("LAZYOS_CREDENTIAL_KEY", undefined); // absent in shell, present in file
    setEnv("LAZYOS_AUTH_SECRET", undefined);

    await runHealer("env-secrets");
    const after = readFileSync(envFile, "utf8");
    // The original credential key must survive verbatim.
    expect(after).toContain(`LAZYOS_CREDENTIAL_KEY=${existingKey}`);
    const credCount = (after.match(/^LAZYOS_CREDENTIAL_KEY=/gm) ?? []).length;
    expect(credCount).toBe(1);
    // The genuinely-missing auth secret should have been appended once.
    expect(after).toMatch(/^LAZYOS_AUTH_SECRET=[0-9a-f]{64}$/m);
  });

  it("is a noop when both secrets are already in the shell env", async () => {
    writeFileSync(envFile, "# clean\n");
    setEnv("LAZYOS_CREDENTIAL_KEY", "a".repeat(64));
    setEnv("LAZYOS_AUTH_SECRET", "b".repeat(64));
    const r = await runHealer("env-secrets");
    expect(r.outcome).toBe("noop");
    // Nothing appended.
    expect(readFileSync(envFile, "utf8")).toBe("# clean\n");
    // Avoid touching the file via appendFileSync in any later test run.
    appendFileSync(envFile, "");
  });
});
