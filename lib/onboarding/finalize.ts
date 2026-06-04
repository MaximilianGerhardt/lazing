/**
 * Finalize: boot services + verify ports (Track B, B5).
 *
 * The last wizard step. It:
 *   1. Verifies the web port (the process serving this request) is up.
 *   2. Verifies the agent server port; if down, boots it (detached) and
 *      re-probes with a short backoff.
 *   3. Returns a verdict the route uses to mark completion + set the cookie.
 *
 * Booting is best-effort and non-fatal: a degraded verdict (agent not up) must
 * never block completion — the operator can start it later via
 * `scripts/lazyos-services.sh` or `pnpm dev:agent`.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

export interface PortStatus {
  name: "web" | "agent";
  port: number;
  reachable: boolean;
}

export interface FinalizeResult {
  status: "ready" | "degraded";
  ports: PortStatus[];
  agentBooted: boolean;
  detail: string;
}

function webPort(): number {
  return Number(process.env.LAZYOS_WEB_PORT ?? process.env.PORT ?? 4200);
}

function agentPort(): number {
  return Number(process.env.LAZYOS_AGENT_PORT ?? 4201);
}

function host(): string {
  return process.env.LAZYOS_AGENT_HOST?.trim() || "127.0.0.1";
}

/** TCP connect probe with a short timeout. Resolves true if the port accepts. */
export function probePort(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host());
  });
}

/**
 * Boot the agent server detached via `pnpm start` in ./server. Inherits the
 * environment so the agent picks up the same secrets/DB path. Non-blocking —
 * the caller re-probes the port to confirm.
 */
export function bootAgentServer(): { spawned: boolean; detail: string } {
  try {
    const serverDir = path.join(process.cwd(), "server");
    const child = spawn("pnpm", ["start"], {
      cwd: serverDir,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return { spawned: true, detail: `spawned agent server (pid ${child.pid ?? "?"})` };
  } catch (err) {
    return {
      spawned: false,
      detail: `agent boot failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run the finalize sequence. `bootAgent` defaults to true; pass false in
 * environments (tests / CI) where spawning a real server is undesirable.
 */
export async function finalizeServices(
  opts: { bootAgent?: boolean } = {},
): Promise<FinalizeResult> {
  const bootAgent = opts.bootAgent ?? true;
  const wPort = webPort();
  const aPort = agentPort();

  const webReachable = await probePort(wPort);
  let agentReachable = await probePort(aPort);
  let bootAttempted = false;
  let bootDetail = "";

  if (!agentReachable && bootAgent) {
    const boot = bootAgentServer();
    bootAttempted = boot.spawned;
    bootDetail = boot.detail;
    // Give the agent server a moment to bind, with a few retries.
    for (let i = 0; i < 6 && !agentReachable; i++) {
      await sleep(700);
      agentReachable = await probePort(aPort);
    }
  }

  // Honest signal: count the agent as "booted" only if our boot attempt
  // actually made the port reachable. A detached spawn can "succeed" (the
  // child is created) yet die before binding — spawn success alone is a lie.
  const agentBooted = bootAttempted && agentReachable;
  if (bootAttempted && !agentReachable) {
    bootDetail = `${bootDetail} — but :${aPort} never became reachable`.trim();
  }

  const ports: PortStatus[] = [
    { name: "web", port: wPort, reachable: webReachable },
    { name: "agent", port: aPort, reachable: agentReachable },
  ];

  // Web must be up (it is — it is serving this request); agent is best-effort.
  const status: FinalizeResult["status"] = webReachable && agentReachable ? "ready" : "degraded";
  const detail =
    status === "ready"
      ? `web :${wPort} and agent :${aPort} reachable`
      : `${webReachable ? "" : `web :${wPort} unreachable. `}${agentReachable ? "" : `agent :${aPort} unreachable. `}${bootDetail}`.trim();

  return { status, ports, agentBooted, detail };
}
