/**
 * lib/deploy/serve-local.ts
 * -------------------------
 * W1.4 — Lokaler Static-Serve + (optional) Tailscale-Public-Serve + Preview-URL
 * (2026-05-30, Opus 4.8 · Plan eager-orbiting-avalanche.md).
 *
 * NACH einem erfolgreichen (Auto-)Merge der zusammengesetzten Website auf `main`
 * liegt eine ansehbare `index.html` im Workspace-Repo. Diese Datei wird hier
 * statisch ausgeliefert, damit der Owner sie SOFORT im Browser (auch am Handy)
 * öffnen kann — der „Ergebnis-Moment", der bisher fehlte.
 *
 *   1. `http-server <repoPath> -p <port> --silent` (detached) auf einem
 *      deterministischen Port (Hash der workspaceId → 4300–4399). Liefert immer
 *      eine lokale `http://127.0.0.1:<port>`-URL.
 *   2. NUR mit `LAZYOS_SERVE_LOCAL='on'`: zusätzlich `tailscale serve --bg
 *      --https=<port> http://127.0.0.1:<port>` → eine tappbare `*.ts.net`-URL
 *      (mobil von unterwegs). Ohne das Flag bleibt es bei der lokalen URL —
 *      KEIN Tailscale-Spawn (kein Public-Exposure ohne explizite Owner-Wahl).
 *
 * ── Restart-Robustheit (2026-05-30, Härtung für wiederholte Läufe) ───────────
 * Die In-Process `served`-Map überlebt KEINEN Server-Restart. Ein 2. Lauf nach
 * Restart wüsste sonst nicht, dass schon ein http-server auf dem Workspace-Port
 * läuft → Doppel-Spawn → EADDRINUSE → Zombie hält den Port, neuer Serve scheitert,
 * Preview tot. Darum entscheidet jetzt ein PORT-PROBE (nicht die Map) über den
 * Spawn:
 *   - Port ist GESUND (http-server antwortet auf 127.0.0.1:<port>)  → wiederverwenden,
 *     Map rehydrieren, KEIN Spawn (idempotent über Restart hinweg).
 *   - Port belegt, aber TOT / antwortet nicht (Zombie / fremder Halter) → Halter
 *     killen (lsof → kill), dann spawnen.
 *   - Port frei → spawnen.
 * Nach dem Spawn wird ERNEUT geprobt; `spawned`/`note` werden EHRLICH gesetzt
 * (nicht blind `spawned=true`).
 *
 * Lifecycle: pro Workspace EIN http-server (Port-deterministisch). Der http-server
 * serviert das Verzeichnis live → Re-Merge braucht keinen Neustart, die selbe
 * Instanz liefert den neuen Inhalt aus.
 *
 * Strikt fail-soft: KEINE Funktion wirft. Ein Serve-Fehler (kein npx, kein
 * tailscale, Port belegt, Health-Check rot) darf den Merge-Pfad NIE kippen —
 * der Caller ruft das best-effort nach dem Merge.
 *
 * N6: portForWorkspace ist rein deterministisch (testbar ohne I/O). Die I/O-Pfade
 * (Probe, Port-Holder-Lookup, Kill, Spawn) sind über `__deps` injizierbar, damit
 * `pnpm test lib/deploy` Idempotenz / Zombie-Kill / Health OHNE echten Spawn grün
 * prüfen kann.
 */

import { spawn } from "node:child_process";
import { exec } from "node:child_process";
import http from "node:http";
import { defaultWorkspacePath } from "@/lib/workspaces/projects-root";

/** Port-Range für lokale Static-Serves (deterministisch je Workspace). */
const PORT_BASE = 4300;
const PORT_SPAN = 100; // 4300–4399

/**
 * Deterministischer Port aus der workspaceId (FNV-1a-Hash → 4300–4399).
 * Rein funktional (N6) — gleiche workspaceId ⇒ gleicher Port (Re-Serve-Stabilität).
 */
export function portForWorkspace(workspaceId: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  const s = workspaceId ?? "";
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    // FNV-Prime-Multiplikation in 32-bit (Math.imul vermeidet float-Drift).
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PORT_BASE + (h % PORT_SPAN);
}

/** Ergebnis von serveWorkspaceStatic. */
export interface ServeResult {
  /** Lokale URL — IMMER gesetzt (auch ohne Tailscale). */
  readonly localUrl: string;
  /** Öffentliche Tailscale-URL — nur bei LAZYOS_SERVE_LOCAL='on' + Erfolg. */
  readonly publicUrl: string | null;
  /** Der gewählte Port. */
  readonly port: number;
  /**
   * Wurde in diesem Aufruf ein NEUER http-server gestartet (true) oder ein
   * bestehender, GESUNDER Serve wiederverwendet (false)? Health-verifiziert —
   * nicht blind gesetzt.
   */
  readonly spawned: boolean;
  /**
   * Antwortet der Port nach diesem Aufruf nachweislich (Health-Check grün)?
   * true = Preview ist wirklich erreichbar. false = best-effort, evtl. (noch)
   * nicht bereit (siehe `note`).
   */
  readonly healthy: boolean;
  /** Best-effort: Notiz (Health rot, tailscale fehlt, Zombie gekillt …), sonst null. */
  readonly note: string | null;
}

interface ServedEntry {
  port: number;
  pid: number | null;
  publicUrl: string | null;
}

/** Modul-State: pro Workspace höchstens EIN Serve (kein Doppel-Spawn). */
const served = new Map<string, ServedEntry>();

// ── Injizierbare I/O-Abhängigkeiten (Testbarkeit, N6) ────────────────────────
//
// Alle nicht-deterministischen Operationen laufen über dieses Objekt, damit Tests
// Idempotenz / Zombie-Kill / Health treiben können, ohne wirklich zu spawnen oder
// einen Port zu binden. Defaults = echte Implementierungen.

/** Ein im Hintergrund gestarteter Prozess, soweit wir ihn brauchen. */
interface SpawnedHandle {
  pid: number | null;
}

interface ServeDeps {
  /**
   * Health-Probe: antwortet `127.0.0.1:<port>` als HTTP-Server innerhalb von
   * `timeoutMs`? `true` = gesund. Wirft nie (Fehler ⇒ `false`).
   */
  probePort(port: number, timeoutMs: number): Promise<boolean>;
  /**
   * PIDs, die `127.0.0.1:<port>` (LISTEN) halten — für Zombie-Kill. Leer = frei
   * bzw. unbekannt. Wirft nie.
   */
  portHolderPids(port: number): Promise<number[]>;
  /** Killt eine PID (SIGTERM, best-effort). Wirft nie; gibt Erfolg zurück. */
  killPid(pid: number): Promise<boolean>;
  /** Startet den detached http-server für `repoPath` auf `port`. Wirft bei Spawn-Fehler. */
  spawnHttpServer(repoPath: string, port: number): SpawnedHandle;
  /** Startet den detached `tailscale serve` auf `port`. Wirft bei Spawn-Fehler. */
  spawnTailscaleServe(port: number, localUrl: string): SpawnedHandle;
  /** Pausiert `ms` (Spawn-Settle vor Re-Probe). Injizierbar ⇒ Tests warten nicht real. */
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

// ── Tuning-Konstanten (Probe-Timeouts / Re-Probe-Backoff) ────────────────────
const PROBE_TIMEOUT_MS = 800;
const POST_SPAWN_SETTLE_MS = 600;
const POST_SPAWN_PROBE_ATTEMPTS = 4; // ~ 4 × (settle + probe) ≈ wenige Sekunden

/**
 * Echter Health-Probe: ein HEAD/GET auf `http://127.0.0.1:<port>/`. Jede HTTP-
 * Antwort (auch 404) heißt „ein http-server lebt hier" → gesund. ECONNREFUSED /
 * Timeout ⇒ nicht gesund. Wirft nie.
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
        // Statuscode egal — der Socket hat geantwortet ⇒ es lauscht ein HTTP-Server.
        res.resume(); // Body verwerfen, Socket freigeben.
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
 * Echte Port-Holder-Ermittlung via `lsof -t -i TCP@127.0.0.1:<port> -sTCP:LISTEN`.
 * macOS-tauglich. Liefert die LISTEN-PIDs. Wirft nie (lsof fehlt / nichts gefunden
 * ⇒ []).
 */
function realPortHolderPids(port: number): Promise<number[]> {
  return new Promise<number[]>((resolve) => {
    exec(
      `lsof -t -iTCP@127.0.0.1:${port} -sTCP:LISTEN`,
      { timeout: 3000 },
      (_err, stdout) => {
        // lsof exit=1 wenn nichts gefunden — _err ignorieren, stdout parsen.
        const pids = (stdout || "")
          .split(/\s+/)
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
        resolve(Array.from(new Set(pids)));
      },
    );
  });
}

/** Echter Kill: SIGTERM an die PID. Wirft nie. */
function realKillPid(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      process.kill(pid, "SIGTERM");
      resolve(true);
    } catch {
      resolve(false); // ESRCH (schon weg) / EPERM — best-effort.
    }
  });
}

/**
 * Echter http-server-Spawn (detached, Loopback-Bind).
 *
 * -a 127.0.0.1: NUR Loopback binden (NICHT 0.0.0.0). Sonst kollidiert
 * http-server mit `tailscale serve`, das die Tailnet-IP:<port> bereits belegt →
 * EADDRINUSE → http-server stirbt → Tailscale proxyt ins Leere (502). Mit
 * Loopback-Bind koexistieren beide; Tailscale proxyt auf 127.0.0.1:<port>.
 * (Empirisch verifiziert 2026-05-30.)
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

/** Echter tailscale-serve-Spawn (detached, dedizierter https-Port = Workspace-Port). */
function realSpawnTailscaleServe(port: number, localUrl: string): SpawnedHandle {
  // WICHTIG: dedizierter, deterministischer https-Port (= Workspace-Port,
  // 4300–4399) — NIEMALS --https=443: das würde die bestehende Tailscale-
  // :443→:4174 / :8443→:4200-Belegung überschreiben.
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

/** Liest den (deterministischen) tailnet-Host aus der ENV, falls bekannt. */
function tailnetHostFromEnv(): string | null {
  const h = process.env.LAZYOS_TAILNET_HOST?.trim();
  return h && h.length > 0 ? h.replace(/^https?:\/\//, "").replace(/\/+$/, "") : null;
}

// ── Health-/Zombie-Logik (deterministisch testbar über `deps`) ───────────────

/** Ergebnis der Port-Vorbereitung — vor einem etwaigen Spawn. */
type PortState =
  | { kind: "healthy" } // schon ein gesunder http-server → wiederverwenden
  | { kind: "free" } // niemand hält den Port → spawnen
  | { kind: "zombie"; killedPids: number[]; survivors: number[] }; // Halter gekillt → spawnen

/**
 * Untersucht den Port UNABHÄNGIG von der In-Process-Map (Restart-robust):
 *   1. Probe → gesund? dann „healthy" (wiederverwenden).
 *   2. Sonst Port-Holder ermitteln; gibt es Halter, sind sie tot/fremd → killen.
 *      (Ein gesunder Serve wäre in Schritt 1 schon erkannt worden.)
 *   3. Keine Halter → „free".
 * Wirft nie.
 */
export async function inspectPort(port: number): Promise<PortState> {
  const healthy = await deps.probePort(port, PROBE_TIMEOUT_MS).catch(() => false);
  if (healthy) return { kind: "healthy" };

  const holders = await deps.portHolderPids(port).catch(() => [] as number[]);
  if (holders.length === 0) return { kind: "free" };

  // Port belegt, aber NICHT gesund (Probe rot) → Zombie / fremder Halter killen.
  const killed: number[] = [];
  for (const pid of holders) {
    const ok = await deps.killPid(pid).catch(() => false);
    if (ok) killed.push(pid);
  }
  // Kurze Settle-Zeit, dann prüfen, ob der Port wirklich frei wurde.
  await deps.sleep(POST_SPAWN_SETTLE_MS).catch(() => {});
  const survivors = await deps.portHolderPids(port).catch(() => [] as number[]);
  return { kind: "zombie", killedPids: killed, survivors };
}

/**
 * Spawnt + verifiziert: startet http-server und probt mehrfach (mit Settle-Backoff),
 * bis der Port antwortet oder die Versuche erschöpft sind. Liefert, ob der Port
 * nach dem Spawn nachweislich gesund ist. Wirft nie.
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

/** Hängt eine weitere Notiz an (kein Verlust der vorigen). */
function appendNote(prev: string | null, next: string | null): string | null {
  if (!next) return prev;
  if (!prev) return next;
  return `${prev} | ${next}`;
}

/**
 * Startet (oder reused) einen statischen Serve für die Website eines Workspace.
 *
 * @param repoPath    optionaler expliziter Repo-Pfad; Fallback =
 *                    defaultWorkspacePath(workspaceId).
 * @param workspaceId Scope (N9) — bestimmt Port + Lifecycle-Schlüssel.
 *
 * Wirft NIE (fail-soft). Liefert immer eine lokale URL; publicUrl nur bei
 * LAZYOS_SERVE_LOCAL='on' + erfolgreichem tailscale-serve. `spawned`/`healthy`
 * sind health-verifiziert (Restart-robust, kein blindes `spawned=true`).
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

  // ── 1. Restart-robuste Idempotenz: PROBE entscheidet, NICHT die Map ────────
  // Vor jedem Spawn prüfen, ob der Port schon einen gesunden http-server hat —
  // egal ob die In-Process-Map ihn kennt (überlebt keinen Restart).
  const state = await inspectPort(port).catch(
    () => ({ kind: "free" }) as PortState, // fail-soft: im Zweifel spawnen
  );

  if (state.kind === "healthy") {
    // Schon ein gesunder Serve (evtl. aus einem früheren Prozess-Leben) → reuse.
    healthy = true;
    spawned = false;
    const prior = served.get(workspaceId);
    // Map rehydrieren, damit publicUrl etc. konsistent bleibt.
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
    // ── 2. Spawn + Health-verifizieren (ehrliches `spawned`/`healthy`) ───────
    const res = await spawnAndVerify(repoPath, port);
    spawned = true; // wir HABEN einen Spawn versucht
    healthy = res.healthy;
    note = appendNote(note, res.note);
    served.set(workspaceId, { port, pid: res.pid, publicUrl: null });
    if (!res.healthy && res.pid == null) {
      // Spawn selbst scheiterte (kein npx) → spawned ehrlich auf false.
      spawned = false;
    }
  }

  // ── 3. Tailscale serve — NUR mit LAZYOS_SERVE_LOCAL='on' ──────────────────
  // Idempotent: `tailscale serve` ist deklarativ; mehrfacher Aufruf mit gleichem
  // Mapping ist ein no-op-Re-Apply. Darum auch bei Reuse erneut anwenden
  // (stellt das Mapping nach einem Tailscale-/Server-Restart wieder her).
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

// ── Test-Hooks ───────────────────────────────────────────────────────────────

/** Nur für Tests: den Lifecycle-State zurücksetzen. */
export function __resetServeStateForTests(): void {
  served.clear();
  deps = realDeps;
}

/**
 * Nur für Tests: I/O-Abhängigkeiten teilweise überschreiben (Probe/Holder/Kill/
 * Spawn/Sleep), damit Idempotenz / Zombie-Kill / Health OHNE echten Spawn
 * deterministisch geprüft werden können. Nicht gesetzte Felder bleiben real.
 */
export function __setServeDepsForTests(overrides: Partial<ServeDeps>): void {
  deps = { ...realDeps, ...overrides };
}

/** Nur für Tests: aktuellen Map-Eintrag lesen (Rehydrierung verifizieren). */
export function __peekServedForTests(workspaceId: string): { port: number; pid: number | null } | null {
  const e = served.get(workspaceId);
  return e ? { port: e.port, pid: e.pid } : null;
}
