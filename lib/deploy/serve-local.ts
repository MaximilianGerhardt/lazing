/**
 * lib/deploy/serve-local.ts
 * -------------------------
 * W1.4 — local static serve + (optional) Tailscale public serve + preview URL
 * (2026-05-30, Opus 4.8 · Plan eager-orbiting-avalanche.md).
 *
 * AFTER a successful (auto-)merge of the assembled website onto `main`
 * there is a viewable `index.html` in the workspace repo. This file is served
 * statically here so the owner can open it IMMEDIATELY in the browser (also on
 * the phone) — the „Ergebnis-Moment" (result moment) that was missing so far.
 *
 *   1. `http-server <repoPath> -p <port> --silent` (detached) on a
 *      deterministic port (hash of the workspaceId → 4300–4399). Always returns
 *      a local `http://127.0.0.1:<port>` URL.
 *   2. ONLY with `LAZYOS_SERVE_LOCAL='on'`: additionally `tailscale serve --bg
 *      --https=<port> http://127.0.0.1:<port>` → a tappable `*.ts.net` URL
 *      (mobile on the go). Without the flag it stays with the local URL —
 *      NO Tailscale spawn (no public exposure without an explicit owner choice).
 *
 * ── Restart robustness (2026-05-30, hardening for repeated runs) ─────────────
 * The in-process `served` map does NOT survive a server restart. A 2nd run after
 * a restart would otherwise not know that an http-server is already running on
 * the workspace port → double spawn → EADDRINUSE → a zombie holds the port, the
 * new serve fails, the preview is dead. Therefore a PORT PROBE (not the map) now
 * decides the spawn:
 *   - Port is HEALTHY (http-server answers on 127.0.0.1:<port>)  → reuse,
 *     rehydrate the map, NO spawn (idempotent across restarts).
 *   - Port occupied but DEAD / does not answer (zombie / foreign holder) → kill
 *     the holder (lsof → kill), then spawn.
 *   - Port free → spawn.
 * After the spawn it is probed AGAIN; `spawned`/`note` are set HONESTLY
 * (not blindly `spawned=true`).
 *
 * Lifecycle: ONE http-server per workspace (port-deterministic). The http-server
 * serves the directory live → a re-merge needs no restart, the same
 * instance serves the new content.
 *
 * Strictly fail-soft: NO function throws. A serve error (no npx, no
 * tailscale, port occupied, health check red) must NEVER tip the merge path —
 * the caller invokes this best-effort after the merge.
 *
 * N6: portForWorkspace is purely deterministic (testable without I/O). The I/O paths
 * (probe, port-holder lookup, kill, spawn) are injectable via `__deps`, so that
 * `pnpm test lib/deploy` can check idempotency / zombie-kill / health green
 * WITHOUT a real spawn.
 */

import { spawn } from "node:child_process";
import { exec } from "node:child_process";
import http from "node:http";
import { defaultWorkspacePath } from "@/lib/workspaces/projects-root";

/** Port range for local static serves (deterministic per workspace). */
const PORT_BASE = 4300;
const PORT_SPAN = 100; // 4300–4399

/**
 * Deterministic port from the workspaceId (FNV-1a hash → 4300–4399).
 * Purely functional (N6) — same workspaceId ⇒ same port (re-serve stability).
 */
export function portForWorkspace(workspaceId: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  const s = workspaceId ?? "";
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // FNV-prime multiplication in 32-bit (Math.imul avoids float drift).
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PORT_BASE + (h % PORT_SPAN);
}

/** Result of serveWorkspaceStatic. */
export interface ServeResult {
  /** Local URL — ALWAYS set (also without Tailscale). */
  readonly localUrl: string;
  /** Public Tailscale URL — only with LAZYOS_SERVE_LOCAL='on' + success. */
  readonly publicUrl: string | null;
  /** The chosen port. */
  readonly port: number;
  /**
   * Was a NEW http-server started in this call (true) or an
   * existing, HEALTHY serve reused (false)? Health-verified —
   * not set blindly.
   */
  readonly spawned: boolean;
  /**
   * Does the port demonstrably answer after this call (health check green)?
   * true = the preview is really reachable. false = best-effort, possibly (not yet)
   * ready (see `note`).
   */
  readonly healthy: boolean;
  /** Best-effort: note (health red, tailscale missing, zombie killed …), otherwise null. */
  readonly note: string | null;
}

interface ServedEntry {
  port: number;
  pid: number | null;
  publicUrl: string | null;
}

/** Module state: at most ONE serve per workspace (no double spawn). */
const served = new Map<string, ServedEntry>();

// ── Injectable I/O dependencies (testability, N6) ────────────────────────────
//
// All non-deterministic operations run through this object so tests can
// drive idempotency / zombie-kill / health without really spawning or
// binding a port. Defaults = real implementations.

/** A process started in the background, as far as we need it. */
interface SpawnedHandle {
  pid: number | null;
}

interface ServeDeps {
  /**
   * Health probe: does `127.0.0.1:<port>` answer as an HTTP server within
   * `timeoutMs`? `true` = healthy. Never throws (error ⇒ `false`).
   */
  probePort(port: number, timeoutMs: number): Promise<boolean>;
  /**
   * PIDs holding `127.0.0.1:<port>` (LISTEN) — for zombie-kill. Empty = free
   * or unknown. Never throws.
   */
  portHolderPids(port: number): Promise<number[]>;
  /** Kills a PID (SIGTERM, best-effort). Never throws; returns success. */
  killPid(pid: number): Promise<boolean>;
  /** Starts the detached http-server for `repoPath` on `port`. Throws on a spawn error. */
  spawnHttpServer(repoPath: string, port: number): SpawnedHandle;
  /** Starts the detached `tailscale serve` on `port`. Throws on a spawn error. */
  spawnTailscaleServe(port: number, localUrl: string): SpawnedHandle;
  /** Pauses `ms` (spawn settle before re-probe). Injectable ⇒ tests do not wait for real. */
  sleep(ms: number): Promise<void>;
}

const realDeps: ServeDeps = {
  probePort: realProbePort,
  portHolderPids: realPortHolderPids,
  killPid: realKillPid,
  spawnHttpServer: realSpawnHttpServer,
  spawnTailscaleServe: realSpawnTailscaleServe,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let deps: ServeDeps = realDeps;

// ── Tuning constants (probe timeouts / re-probe backoff) ─────────────────────
const PROBE_TIMEOUT_MS = 800;
const POST_SPAWN_SETTLE_MS = 600;
const POST_SPAWN_PROBE_ATTEMPTS = 4; // ~ 4 × (settle + probe) ≈ a few seconds

/**
 * Real health probe: a HEAD/GET on `http://127.0.0.1:<port>/`. Any HTTP
 * response (even 404) means "an http-server lives here" → healthy. ECONNREFUSED /
 * timeout ⇒ not healthy. Never throws.
 */
function realProbePort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs },
      (res) => {
        // Status code doesn't matter — the socket answered ⇒ an HTTP server is listening.
        res.resume(); // Discard the body, free the socket.
        done(true);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false)); // ECONNREFUSED etc.
    req.end();
  });
}

/**
 * Real port-holder lookup via `lsof -t -i TCP@127.0.0.1:<port> -sTCP:LISTEN`.
 * macOS-capable. Returns the LISTEN PIDs. Never throws (lsof missing / nothing found
 * ⇒ []).
 */
function realPortHolderPids(port: number): Promise<number[]> {
  return new Promise<number[]>((resolve) => {
    exec(
      `lsof -t -iTCP@127.0.0.1:${port} -sTCP:LISTEN`,
      { timeout: 3000 },
      (_err, stdout) => {
        // lsof exits 1 when nothing is found — ignore _err, parse stdout.
        const pids = (stdout || "")
          .split(/\s+/)
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
        resolve(Array.from(new Set(pids)));
      },
    );
  });
}

/** Real kill: SIGTERM to the PID. Never throws. */
function realKillPid(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      process.kill(pid, "SIGTERM");
      resolve(true);
    } catch {
      resolve(false); // ESRCH (already gone) / EPERM — best-effort.
    }
  });
}

/**
 * Real http-server spawn (detached, loopback bind).
 *
 * -a 127.0.0.1: bind ONLY loopback (NOT 0.0.0.0). Otherwise
 * http-server collides with `tailscale serve`, which already occupies the
 * tailnet IP:<port> → EADDRINUSE → http-server dies → Tailscale proxies into
 * the void (502). With a loopback bind both coexist; Tailscale proxies to
 * 127.0.0.1:<port>. (Empirically verified 2026-05-30.)
 */
function realSpawnHttpServer(repoPath: string, port: number): SpawnedHandle {
  const child = spawn(
    "npx",
    ["--yes", "http-server", repoPath, "-p", String(port), "-a", "127.0.0.1", "--silent", "-c-1"],
    { detached: true, stdio: "ignore", env: process.env },
  );
  child.on("error", (err) => {
    console.warn(
      `[serve-local] http-server spawn error port=${port}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  });
  child.unref();
  return { pid: child.pid ?? null };
}

/** Real tailscale-serve spawn (detached, dedicated https port = workspace port). */
function realSpawnTailscaleServe(port: number, localUrl: string): SpawnedHandle {
  // IMPORTANT: dedicated, deterministic https port (= workspace port,
  // 4300–4399) — NEVER --https=443: that would overwrite the existing Tailscale
  // :443→:4174 / :8443→:4200 mapping.
  const ts = spawn(
    "tailscale",
    ["serve", "--bg", `--https=${port}`, localUrl],
    { detached: true, stdio: "ignore", env: process.env },
  );
  ts.on("error", (err) => {
    console.warn(
      `[serve-local] tailscale serve error port=${port}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  });
  ts.unref();
  return { pid: ts.pid ?? null };
}

/** Reads the (deterministic) tailnet host from the ENV, if known. */
function tailnetHostFromEnv(): string | null {
  const h = process.env.LAZYOS_TAILNET_HOST?.trim();
  return h && h.length > 0 ? h.replace(/^https?:\/\//, "").replace(/\/+$/, "") : null;
}

// ── Health/zombie logic (deterministically testable via `deps`) ──────────────

/** Result of the port preparation — before a possible spawn. */
type PortState =
  | { kind: "healthy" } // already a healthy http-server → reuse
  | { kind: "free" } // nobody holds the port → spawn
  | { kind: "zombie"; killedPids: number[]; survivors: number[] }; // holder killed → spawn

/**
 * Inspects the port INDEPENDENTLY of the in-process map (restart-robust):
 *   1. Probe → healthy? then "healthy" (reuse).
 *   2. Otherwise look up port holders; if there are holders, they are dead/foreign → kill.
 *      (A healthy serve would already have been detected in step 1.)
 *   3. No holders → "free".
 * Never throws.
 */
export async function inspectPort(port: number): Promise<PortState> {
  const healthy = await deps.probePort(port, PROBE_TIMEOUT_MS).catch(() => false);
  if (healthy) return { kind: "healthy" };

  const holders = await deps.portHolderPids(port).catch(() => [] as number[]);
  if (holders.length === 0) return { kind: "free" };

  // Port occupied but NOT healthy (probe red) → kill the zombie / foreign holder.
  const killed: number[] = [];
  for (const pid of holders) {
    const ok = await deps.killPid(pid).catch(() => false);
    if (ok) killed.push(pid);
  }
  // Short settle time, then check whether the port really became free.
  await deps.sleep(POST_SPAWN_SETTLE_MS).catch(() => {});
  const survivors = await deps.portHolderPids(port).catch(() => [] as number[]);
  return { kind: "zombie", killedPids: killed, survivors };
}

/**
 * Spawn + verify: starts http-server and probes repeatedly (with settle backoff),
 * until the port answers or the attempts are exhausted. Returns whether the port
 * is demonstrably healthy after the spawn. Never throws.
 */
async function spawnAndVerify(
  repoPath: string,
  port: number,
): Promise<{ healthy: boolean; pid: number | null; note: string | null }> {
  let handle: SpawnedHandle;
  try {
    handle = deps.spawnHttpServer(repoPath, port);
  } catch (e) {
    return {
      healthy: false,
      pid: null,
      note: `http-server spawn failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  for (let attempt = 0; attempt < POST_SPAWN_PROBE_ATTEMPTS; attempt += 1) {
    await deps.sleep(POST_SPAWN_SETTLE_MS).catch(() => {});
    const ok = await deps.probePort(port, PROBE_TIMEOUT_MS).catch(() => false);
    if (ok) return { healthy: true, pid: handle.pid, note: null };
  }
  return {
    healthy: false,
    pid: handle.pid,
    note:
      `http-server gestartet (pid=${handle.pid ?? "?"}), aber Port ${port} ` +
      `antwortet nach ${POST_SPAWN_PROBE_ATTEMPTS} Health-Checks (noch) nicht — ` +
      `Preview evtl. erst gleich erreichbar.`,
  };
}

/** Appends another note (no loss of the previous one). */
function appendNote(prev: string | null, next: string | null): string | null {
  if (!next) return prev;
  if (!prev) return next;
  return `${prev} | ${next}`;
}

/**
 * Starts (or reuses) a static serve for a workspace's website.
 *
 * @param repoPath    optional explicit repo path; fallback =
 *                    defaultWorkspacePath(workspaceId).
 * @param workspaceId scope (N9) — determines the port + lifecycle key.
 *
 * NEVER throws (fail-soft). Always returns a local URL; publicUrl only with
 * LAZYOS_SERVE_LOCAL='on' + a successful tailscale-serve. `spawned`/`healthy`
 * are health-verified (restart-robust, no blind `spawned=true`).
 */
export async function serveWorkspaceStatic(opts: {
  repoPath?: string;
  workspaceId: string;
}): Promise<ServeResult> {
  const { workspaceId } = opts;
  const repoPath = opts.repoPath ?? defaultWorkspacePath(workspaceId);
  const port = portForWorkspace(workspaceId);
  const localUrl = `http://127.0.0.1:${port}`;
  const tailscaleOn = process.env.LAZYOS_SERVE_LOCAL === "on";

  let note: string | null = null;
  let spawned = false;
  let healthy = false;

  // ── 1. Restart-robust idempotency: the PROBE decides, NOT the map ──────────
  // Before any spawn, check whether the port already has a healthy http-server —
  // regardless of whether the in-process map knows it (which survives no restart).
  const state = await inspectPort(port).catch(
    () => ({ kind: "free" }) as PortState, // fail-soft: spawn when in doubt
  );

  if (state.kind === "healthy") {
    // Already a healthy serve (possibly from an earlier process life) → reuse.
    healthy = true;
    spawned = false;
    const prior = served.get(workspaceId);
    // Rehydrate the map so publicUrl etc. stays consistent.
    if (!prior) served.set(workspaceId, { port, pid: null, publicUrl: null });
    note = appendNote(note, "bestehender gesunder Serve wiederverwendet (kein Spawn).");
  } else {
    if (state.kind === "zombie") {
      const killedTxt = state.killedPids.length
        ? `Zombie/Port-Halter auf ${port} gekillt: pid ${state.killedPids.join(", ")}`
        : `Port ${port} belegt, aber Halter nicht killbar`;
      const survTxt = state.survivors.length
        ? ` (noch belegt von pid ${state.survivors.join(", ")} — Spawn könnte EADDRINUSE geben)`
        : "";
      note = appendNote(note, killedTxt + survTxt + ".");
    }
    // ── 2. Spawn + health-verify (honest `spawned`/`healthy`) ────────────────
    const res = await spawnAndVerify(repoPath, port);
    spawned = true; // we DID attempt a spawn
    healthy = res.healthy;
    note = appendNote(note, res.note);
    served.set(workspaceId, { port, pid: res.pid, publicUrl: null });
    if (!res.healthy && res.pid == null) {
      // The spawn itself failed (no npx) → spawned honestly to false.
      spawned = false;
    }
  }

  // ── 3. Tailscale serve — ONLY with LAZYOS_SERVE_LOCAL='on' ────────────────
  // Idempotent: `tailscale serve` is declarative; a repeated call with the same
  // mapping is a no-op re-apply. Therefore re-apply it on reuse as well
  // (restores the mapping after a Tailscale/server restart).
  let publicUrl: string | null = null;
  if (tailscaleOn) {
    try {
      deps.spawnTailscaleServe(port, localUrl);
      const host = tailnetHostFromEnv();
      publicUrl = host ? `https://${host}:${port}` : null;
      const cur = served.get(workspaceId);
      if (cur) cur.publicUrl = publicUrl;
      if (!host) {
        note = appendNote(
          note,
          "tailscale serve angewandt, aber LAZYOS_TAILNET_HOST nicht gesetzt — " +
            `öffentliche URL = https://<dein-host>.ts.net:${port} (lokal: ${localUrl}).`,
        );
      }
    } catch (e) {
      note = appendNote(
        note,
        `tailscale serve failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      console.warn(`[serve-local] tailscale serve failed (ws=${workspaceId}): ${e}`);
    }
  }

  return { localUrl, publicUrl, port, spawned, healthy, note };
}

// ── Test hooks ───────────────────────────────────────────────────────────────

/** For tests only: reset the lifecycle state. */
export function __resetServeStateForTests(): void {
  served.clear();
  deps = realDeps;
}

/**
 * For tests only: partially override the I/O dependencies (probe/holder/kill/
 * spawn/sleep) so idempotency / zombie-kill / health can be checked
 * deterministically WITHOUT a real spawn. Unset fields stay real.
 */
export function __setServeDepsForTests(overrides: Partial<ServeDeps>): void {
  deps = { ...realDeps, ...overrides };
}

/** For tests only: read the current map entry (verify rehydration). */
export function __peekServedForTests(workspaceId: string): { port: number; pid: number | null } | null {
  const e = served.get(workspaceId);
  return e ? { port: e.port, pid: e.pid } : null;
}
