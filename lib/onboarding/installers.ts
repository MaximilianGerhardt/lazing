/**
 * Consented one-click installer allowlist (Track B, B2).
 *
 * The frozen INSTALL_TARGETS map is the ONLY source of truth for what the
 * install route may execute. The client sends an opaque target id; the route
 * looks it up here. An unknown id => 400 (no passthrough of client-supplied
 * commands, no arg injection surface).
 *
 * Security posture:
 *   - Every entry runs with `shell: false` and a fixed argv array. There is
 *     no string interpolation of user input anywhere in this module.
 *   - The single exception is the Ollama installer, which upstream only ships
 *     as a `curl … | sh` one-liner. It is a CONSTANT command string, gated
 *     behind `confirmShellInstaller: true`, and the route refuses to run it
 *     unless the client explicitly opts in. It is never built from input.
 */

import os from "node:os";

export type InstallPlatform = "darwin" | "linux" | "win32";

export interface InstallSpec {
  /** Executable to spawn (resolved on PATH). */
  cmd: string;
  /** Fixed argv — never contains user input. */
  args: string[];
  /** When true, the command MUST be run via a shell (Ollama curl one-liner). */
  shell?: boolean;
}

export interface InstallTarget {
  id: string;
  /** Human label shown on the button. */
  label: string;
  /** What the user is consenting to, rendered verbatim in the UI. */
  description: string;
  /**
   * Per-platform spec. A platform key may be absent (target not installable
   * that way there) — the route returns a clear "unsupported platform" error.
   */
  byPlatform: Partial<Record<InstallPlatform, InstallSpec>>;
  /**
   * True only for the Ollama shell installer. The route refuses to run a
   * `shell:true` spec unless the request body sets `confirmShellInstaller`.
   */
  confirmShellInstaller?: boolean;
}

/**
 * The frozen allowlist. `as const`-flavored via Object.freeze so a typo
 * elsewhere cannot silently mutate it at runtime.
 */
export const INSTALL_TARGETS: Readonly<Record<string, InstallTarget>> = Object.freeze({
  node: {
    id: "node",
    label: "Node.js",
    description: "Node.js is required to run lazyOS. Install it from nodejs.org or your package manager.",
    // Node is a prerequisite of the running server, so there is no safe
    // in-process installer; we surface guidance only (no exec spec).
    byPlatform: {},
  },
  pnpm: {
    id: "pnpm",
    label: "pnpm",
    description: "Installs the pnpm package manager via Corepack (runs: corepack enable pnpm).",
    byPlatform: {
      darwin: { cmd: "corepack", args: ["enable", "pnpm"] },
      linux: { cmd: "corepack", args: ["enable", "pnpm"] },
      win32: { cmd: "corepack", args: ["enable", "pnpm"] },
    },
  },
  claude: {
    id: "claude",
    label: "Claude Code CLI",
    description: "Installs the Claude Code CLI globally (runs: npm i -g @anthropic-ai/claude-code).",
    byPlatform: {
      darwin: { cmd: "npm", args: ["i", "-g", "@anthropic-ai/claude-code"] },
      linux: { cmd: "npm", args: ["i", "-g", "@anthropic-ai/claude-code"] },
      win32: { cmd: "npm", args: ["i", "-g", "@anthropic-ai/claude-code"] },
    },
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex CLI",
    description: "Installs the OpenAI Codex CLI globally (runs: npm i -g @openai/codex).",
    byPlatform: {
      darwin: { cmd: "npm", args: ["i", "-g", "@openai/codex"] },
      linux: { cmd: "npm", args: ["i", "-g", "@openai/codex"] },
      win32: { cmd: "npm", args: ["i", "-g", "@openai/codex"] },
    },
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    description:
      "Installs Ollama for local models (runs the official installer: curl -fsSL https://ollama.com/install.sh | sh). This requires a shell and is opt-in.",
    confirmShellInstaller: true,
    byPlatform: {
      // Constant command string — never built from input. Shell required by
      // the upstream installer. macOS users normally install Ollama.app, but
      // the install.sh works on macOS too.
      darwin: { cmd: "curl -fsSL https://ollama.com/install.sh | sh", args: [], shell: true },
      linux: { cmd: "curl -fsSL https://ollama.com/install.sh | sh", args: [], shell: true },
      // No Windows shell installer — Ollama ships a separate .exe.
    },
  },
  "ollama-model": {
    id: "ollama-model",
    label: "Default Ollama model",
    description: "Pulls a small default model for role/risk checks (runs: ollama pull nomic-embed-text).",
    byPlatform: {
      darwin: { cmd: "ollama", args: ["pull", "nomic-embed-text"] },
      linux: { cmd: "ollama", args: ["pull", "nomic-embed-text"] },
      win32: { cmd: "ollama", args: ["pull", "nomic-embed-text"] },
    },
  },
});

export type InstallTargetId = keyof typeof INSTALL_TARGETS & string;

/** All allowlisted ids, frozen. */
export const INSTALL_TARGET_IDS: readonly string[] = Object.freeze(
  Object.keys(INSTALL_TARGETS),
);

export function isInstallTargetId(s: string): s is InstallTargetId {
  return Object.prototype.hasOwnProperty.call(INSTALL_TARGETS, s);
}

/** Current platform, narrowed to the supported set. */
export function currentPlatform(): InstallPlatform {
  const p = os.platform();
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  // Treat anything else as linux for spec lookup (POSIX-ish).
  return "linux";
}

export interface ResolvedInstall {
  target: InstallTarget;
  spec: InstallSpec;
  platform: InstallPlatform;
}

export type ResolveError =
  | { ok: false; code: "unknown-target" }
  | { ok: false; code: "no-exec-spec" }
  | { ok: false; code: "unsupported-platform" }
  | { ok: false; code: "needs-shell-confirm" };

export type ResolveResult = ({ ok: true } & ResolvedInstall) | ResolveError;

/**
 * Resolve an opaque target id (+ platform + shell-confirm flag) to a concrete,
 * vetted exec spec. This is the single chokepoint the route trusts.
 */
export function resolveInstall(
  id: string,
  opts: { platform?: InstallPlatform; confirmShellInstaller?: boolean } = {},
): ResolveResult {
  if (!isInstallTargetId(id)) return { ok: false, code: "unknown-target" };
  const target = INSTALL_TARGETS[id];
  const platform = opts.platform ?? currentPlatform();

  if (Object.keys(target.byPlatform).length === 0) {
    return { ok: false, code: "no-exec-spec" };
  }
  const spec = target.byPlatform[platform];
  if (!spec) return { ok: false, code: "unsupported-platform" };

  if (spec.shell && target.confirmShellInstaller && !opts.confirmShellInstaller) {
    return { ok: false, code: "needs-shell-confirm" };
  }

  return { ok: true, target, spec, platform };
}

/** The exact command line a spec will run — for transparent display + audit. */
export function specCommandLine(spec: InstallSpec): string {
  if (spec.shell) return spec.cmd;
  return [spec.cmd, ...spec.args].join(" ");
}
