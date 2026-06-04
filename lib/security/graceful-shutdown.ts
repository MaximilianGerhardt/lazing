/**
 * Graceful Shutdown Coordinator — Production-Hardening Agent 5/8.
 *
 * Single source of truth for SIGTERM/SIGINT lifecycle. The Next.js
 * dev-server already installs its own signal handlers; this helper
 * registers ALONGSIDE them so any code-path that holds an in-flight
 * resource (DB write-batch, SSE stream, claude-cli subprocess) can
 * register a release-hook that runs **before** the process exits.
 *
 * Why a helper instead of inline handlers?
 *   - Avoid duplicate `process.on('SIGTERM', ...)` registrations under
 *     hot-reload (the listener-leak Next.js dev mode is famous for).
 *   - Centralise the 15s "hard-exit" timeout so no single misbehaving
 *     hook can hang shutdown forever.
 *   - Make it trivial for handlers (chat-stream, agent-server proxy,
 *     event-broadcast) to register at module-load time.
 */

import { flog } from "./file-logger";

type Hook = () => void | Promise<void>;

interface RegisteredHook {
  name: string;
  hook: Hook;
}

const HARD_EXIT_MS = Number(process.env.LAZYOS_SHUTDOWN_HARD_MS ?? 15_000);

// Attach to globalThis so Next.js dev-mode hot-reload doesn't double-register.
interface GlobalShutdown {
  __lazyosShutdownHooks?: RegisteredHook[];
  __lazyosShutdownSignalled?: boolean;
  __lazyosShutdownInstalled?: boolean;
}
const G = globalThis as unknown as GlobalShutdown;

function hooks(): RegisteredHook[] {
  if (!G.__lazyosShutdownHooks) G.__lazyosShutdownHooks = [];
  return G.__lazyosShutdownHooks;
}

/**
 * Register a release-hook. Idempotent on `name` — re-registering with the
 * same name replaces the previous hook (useful under hot-reload).
 */
export function onShutdown(name: string, hook: Hook): void {
  const arr = hooks();
  const existing = arr.findIndex((h) => h.name === name);
  if (existing >= 0) arr[existing] = { name, hook };
  else arr.push({ name, hook });
}

/** Drain all registered hooks. Returns when all have settled (resolved or rejected). */
async function drain(): Promise<void> {
  const arr = hooks();
  flog.info("shutdown", "draining", { hookCount: arr.length });

  await Promise.allSettled(
    arr.map(async (h) => {
      try {
        await h.hook();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        flog.error("shutdown.hook", `hook ${h.name} threw: ${msg}`, {
          hook: h.name,
        });
      }
    }),
  );
}

async function handleSignal(sig: string): Promise<void> {
  if (G.__lazyosShutdownSignalled) {
    // Second signal — operator is impatient. Force exit now.
    flog.warn("shutdown", `second ${sig}, forcing exit`);
    process.exit(130);
  }
  G.__lazyosShutdownSignalled = true;
  flog.info("shutdown", `received ${sig}`);

  // Hard-deadline: if drain doesn't finish in HARD_EXIT_MS, exit anyway.
  const hardExit = setTimeout(() => {
    flog.error("shutdown", `hard-exit after ${HARD_EXIT_MS}ms`);
    process.exit(124);
  }, HARD_EXIT_MS);
  hardExit.unref();

  try {
    await drain();
    flog.info("shutdown", "drained cleanly");
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    flog.fatal("shutdown", `drain failed: ${msg}`);
    process.exit(1);
  }
}

/**
 * Install signal handlers once per process. Safe to call repeatedly.
 */
export function installShutdownHandlers(): void {
  if (G.__lazyosShutdownInstalled) return;
  G.__lazyosShutdownInstalled = true;

  process.on("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });
  process.on("SIGINT", () => {
    void handleSignal("SIGINT");
  });

  // Surface uncaught failures to the file log so they're not lost when
  // the parent dev-server captures stdout/stderr in a noisy buffer.
  process.on("uncaughtException", (err) => {
    flog.fatal("uncaughtException", err.message, {
      stack: err.stack?.slice(0, 2000),
    });
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    flog.error("unhandledRejection", msg, {
      stack: reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined,
    });
  });
}

/** Test-only: snapshot of registered hook names. */
export function __debugRegisteredHookNames(): string[] {
  return hooks().map((h) => h.name);
}
