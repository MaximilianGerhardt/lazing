/**
 * Guided + detected Full Access (Track B, B4) — NOT a hard gate.
 *
 * macOS hides powerful permissions (Full Disk Access, Notifications) behind
 * System Settings panes that an app cannot toggle programmatically. So this is
 * "guided + detected", never enforced:
 *
 *   - GUIDE: deep-link the user straight to the right System Settings pane.
 *   - DETECT: a proxy Full-Disk-Access probe. A tiny launchd helper stats a
 *     TCC-protected path; if it can read it, it writes ~/.lazyos/fda-probe.ok.
 *     We just look for that marker (best-effort, non-blocking).
 *   - OPTIONAL: "enable background service" installs + loads the existing
 *     launchd/com.lazyos.routines-tick.plist so routines tick when the app is
 *     closed.
 *
 * On Linux / Windows there is no equivalent gate, so the posture is
 * "not-required" and the step is informational.
 *
 * Nothing here blocks onboarding: the worst case is `partial` / `skipped`.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { BRAND_NAME } from "@/lib/brand";

export type FullAccessPlatform = "darwin" | "linux" | "win32" | "other";

export function fullAccessPlatform(): FullAccessPlatform {
  const p = os.platform();
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  return "other";
}

function lazyosDir(): string {
  const override = process.env.LAZYOS_HOME_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".lazyos");
}

/** Path of the FDA probe marker written by the launchd helper. */
export function fdaProbeMarkerPath(): string {
  return path.join(lazyosDir(), "fda-probe.ok");
}

/** macOS deep-links to the relevant System Settings panes. */
export const MACOS_DEEPLINKS = Object.freeze({
  fullDiskAccess:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  notifications:
    "x-apple.systempreferences:com.apple.preference.notifications",
});

export interface FullAccessProbe {
  platform: FullAccessPlatform;
  /** macOS only: whether the FDA marker exists + is fresh. */
  fdaGranted: boolean;
  /** Whether the background-service launchd plist is installed (loaded). */
  backgroundServiceInstalled: boolean;
  /** Deep-links to show (macOS) or null (other platforms). */
  deeplinks: typeof MACOS_DEEPLINKS | null;
  /** Coarse posture for the wizard summary. */
  posture: "granted" | "partial" | "not-required";
}

const FDA_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — marker is a hint, not a lock

/**
 * Best-effort, non-blocking probe. Never throws; on any error returns a
 * conservative "partial"/"not-required" posture.
 */
export function probeFullAccess(): FullAccessProbe {
  const platform = fullAccessPlatform();

  if (platform !== "darwin") {
    return {
      platform,
      fdaGranted: false,
      backgroundServiceInstalled: backgroundServiceInstalled(),
      deeplinks: null,
      posture: "not-required",
    };
  }

  let fdaGranted = false;
  try {
    const marker = fdaProbeMarkerPath();
    if (existsSync(marker)) {
      const age = Date.now() - statSync(marker).mtimeMs;
      fdaGranted = age <= FDA_MARKER_MAX_AGE_MS;
    }
  } catch {
    fdaGranted = false;
  }

  const bg = backgroundServiceInstalled();
  return {
    platform,
    fdaGranted,
    backgroundServiceInstalled: bg,
    deeplinks: MACOS_DEEPLINKS,
    posture: fdaGranted ? "granted" : "partial",
  };
}

/** Where a loaded LaunchAgent plist would live for the current user. */
function launchAgentTarget(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.lazyos.routines-tick.plist");
}

/** Source plist shipped in the repo. */
function launchAgentSource(): string {
  return path.join(process.cwd(), "launchd", "com.lazyos.routines-tick.plist");
}

export function backgroundServiceInstalled(): boolean {
  if (fullAccessPlatform() !== "darwin") return false;
  try {
    return existsSync(launchAgentTarget());
  } catch {
    return false;
  }
}

export type FullAccessActionOutcome = "done" | "noop" | "skipped" | "failed";

export interface FullAccessActionResult {
  action: "fda-probe-helper" | "enable-background-service";
  outcome: FullAccessActionOutcome;
  detail: string;
}

/**
 * Run the synchronous proxy FDA probe directly (no launchd dependency for the
 * common case): attempt to stat a TCC-protected path. If the read succeeds, the
 * app process already has Full Disk Access, so we write the marker ourselves.
 * This is the "tiny helper that stats a TCC-protected path and writes the
 * marker" — kept in-process so it works even without launchd installed.
 */
export function runFdaProbe(): FullAccessActionResult {
  if (fullAccessPlatform() !== "darwin") {
    return {
      action: "fda-probe-helper",
      outcome: "skipped",
      detail: "Full Disk Access is a macOS-only concept — not required here.",
    };
  }
  // A canonical TCC-protected path: the user's Mail data (or fall back to
  // ~/Library/Application Support/com.apple.TCC).
  const protectedCandidates = [
    path.join(os.homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"),
    path.join(os.homedir(), "Library", "Mail"),
    path.join(os.homedir(), "Library", "Safari"),
  ];
  let readable = false;
  for (const candidate of protectedCandidates) {
    try {
      if (!existsSync(candidate)) continue;
      // IMPORTANT: statSync on a protected DIRECTORY succeeds WITHOUT FDA — TCC
      // gates reading the *contents*, not statting the node. So we must actually
      // read: readdirSync for a directory, or read one byte from a protected file.
      if (statSync(candidate).isDirectory()) {
        readdirSync(candidate);
      } else {
        const fd = openSync(candidate, "r");
        try {
          readSync(fd, Buffer.alloc(1), 0, 1, 0);
        } finally {
          closeSync(fd);
        }
      }
      readable = true;
      break;
    } catch {
      // EPERM / EACCES — no access; keep trying other candidates.
    }
  }

  const dir = lazyosDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* best effort */
  }

  if (readable) {
    try {
      writeFileSync(fdaProbeMarkerPath(), `${new Date().toISOString()}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return {
        action: "fda-probe-helper",
        outcome: "done",
        detail: "Full Disk Access detected — marker written.",
      };
    } catch (err) {
      return {
        action: "fda-probe-helper",
        outcome: "failed",
        detail: `marker write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    action: "fda-probe-helper",
    outcome: "noop",
    detail:
      `Full Disk Access not detected. Use the deep-link, grant access to the ${BRAND_NAME} process, then re-probe.`,
  };
}

/**
 * Optional: install the background-service LaunchAgent by copying the shipped
 * plist into ~/Library/LaunchAgents. We deliberately do NOT auto-`launchctl
 * load` (that can prompt / require the plist to have a concrete INSTALL_DIR);
 * we copy + return the load command for the user to run, keeping the action
 * non-destructive and transparent. Idempotent: a second call is a noop.
 */
export function enableBackgroundService(): FullAccessActionResult {
  if (fullAccessPlatform() !== "darwin") {
    return {
      action: "enable-background-service",
      outcome: "skipped",
      detail: "Background LaunchAgent is macOS-only. On Linux use the systemd unit.",
    };
  }
  const source = launchAgentSource();
  const target = launchAgentTarget();
  if (!existsSync(source)) {
    return {
      action: "enable-background-service",
      outcome: "failed",
      detail: `source plist not found at ${source}`,
    };
  }
  if (existsSync(target)) {
    return {
      action: "enable-background-service",
      outcome: "noop",
      detail: `LaunchAgent already installed at ${target}`,
    };
  }
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    // Copy + substitute the <INSTALL_DIR> placeholder with the real checkout.
    const raw = readFileSync(source, "utf8");
    const substituted = raw.replaceAll("<INSTALL_DIR>", process.cwd());
    writeFileSync(target, substituted, { encoding: "utf8" });
    // If unchanged (no placeholder), the plain copy is also fine.
    if (substituted === raw) copyFileSync(source, target);
    return {
      action: "enable-background-service",
      outcome: "done",
      detail: `Installed ${target}. Load it with: launchctl load ${target}`,
    };
  } catch (err) {
    return {
      action: "enable-background-service",
      outcome: "failed",
      detail: `install failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
