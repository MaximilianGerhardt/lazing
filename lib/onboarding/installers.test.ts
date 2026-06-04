/**
 * Unit tests for the consented installer allowlist (Track B, B2/B6).
 *
 * Focus: the allowlist is frozen, unknown ids are rejected, the shell
 * installer is gated behind explicit confirmation, and no entry exposes an
 * arg-injection surface (fixed argv, single constant shell command).
 */

import { describe, expect, it } from "vitest";

import {
  INSTALL_TARGETS,
  INSTALL_TARGET_IDS,
  isInstallTargetId,
  resolveInstall,
  specCommandLine,
  type InstallPlatform,
} from "./installers";

describe("INSTALL_TARGETS allowlist", () => {
  it("exposes exactly the expected target ids", () => {
    expect([...INSTALL_TARGET_IDS].sort()).toEqual(
      ["claude", "codex", "node", "ollama", "ollama-model", "pnpm"].sort(),
    );
  });

  it("is frozen against runtime mutation", () => {
    expect(Object.isFrozen(INSTALL_TARGETS)).toBe(true);
  });

  it("recognizes only allowlisted ids", () => {
    expect(isInstallTargetId("claude")).toBe(true);
    expect(isInstallTargetId("rm")).toBe(false);
    expect(isInstallTargetId("claude; rm -rf /")).toBe(false);
    expect(isInstallTargetId("")).toBe(false);
  });
});

describe("resolveInstall", () => {
  it("rejects an unknown target", () => {
    const r = resolveInstall("definitely-not-a-target");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown-target");
  });

  it("rejects an injection-flavored id", () => {
    const r = resolveInstall("npm i -g evil");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown-target");
  });

  it("resolves claude to a fixed npm argv on every desktop platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as InstallPlatform[]) {
      const r = resolveInstall("claude", { platform });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.spec.cmd).toBe("npm");
        expect(r.spec.args).toEqual(["i", "-g", "@anthropic-ai/claude-code"]);
        expect(r.spec.shell).toBeFalsy();
      }
    }
  });

  it("reports no-exec-spec for the prerequisite-only node target", () => {
    const r = resolveInstall("node", { platform: "linux" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no-exec-spec");
  });

  it("reports unsupported-platform when a spec is missing for the platform", () => {
    // ollama has no win32 shell installer.
    const r = resolveInstall("ollama", { platform: "win32", confirmShellInstaller: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported-platform");
  });
});

describe("shell-installer gating", () => {
  it("refuses the ollama shell installer without explicit confirmation", () => {
    const r = resolveInstall("ollama", { platform: "linux" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("needs-shell-confirm");
  });

  it("allows it only with confirmShellInstaller=true and keeps the command constant", () => {
    const r = resolveInstall("ollama", { platform: "linux", confirmShellInstaller: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.shell).toBe(true);
      expect(r.spec.cmd).toBe("curl -fsSL https://ollama.com/install.sh | sh");
      expect(specCommandLine(r.spec)).toBe("curl -fsSL https://ollama.com/install.sh | sh");
    }
  });
});

describe("no arg-injection surface", () => {
  it("every non-shell spec uses a fixed argv with no shell metacharacters", () => {
    for (const id of INSTALL_TARGET_IDS) {
      const target = INSTALL_TARGETS[id];
      for (const platform of Object.keys(target.byPlatform) as InstallPlatform[]) {
        const spec = target.byPlatform[platform]!;
        if (spec.shell) {
          // The only shell entry is the constant ollama curl one-liner.
          expect(spec.cmd).toBe("curl -fsSL https://ollama.com/install.sh | sh");
          expect(spec.args).toEqual([]);
          expect(target.confirmShellInstaller).toBe(true);
          continue;
        }
        // Non-shell: cmd is a bare binary; args carry no metacharacters.
        expect(spec.cmd).not.toMatch(/[;&|`$(){}<>]/);
        for (const arg of spec.args) {
          expect(arg).not.toMatch(/[;&|`$(){}<>]/);
        }
      }
    }
  });
});
