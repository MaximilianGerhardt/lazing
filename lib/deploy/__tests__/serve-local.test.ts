// W1.4 — serve-local Port-Hash + Restart-robuste Serve-Härtung (Tests)
// (2026-05-30, Opus 4.8).
//
// Deckt ab:
//   (A) deterministischer Port (4300–4399) je workspaceId, Stabilität, Verteilung.
//   (B) Restart-robuste Idempotenz: GESUNDER Port → Wiederverwendung OHNE Spawn,
//       unabhängig von der In-Process-Map (Server-Restart-Szenario).
//   (C) Zombie-Kill: Port belegt aber TOT (Probe rot) → Halter killen, dann spawnen.
//   (D) Health-verifizierter `spawned`/`healthy`: Spawn ohne antwortenden Port →
//       healthy=false + ehrliche `note`; Spawn-Fehler (kein npx) → spawned=false.
//
// Der echte http-server-/tailscale-Spawn (IO) wird NICHT ausgeführt — alle I/O-
// Pfade (Probe, Port-Holder, Kill, Spawn, Sleep) sind über __setServeDepsForTests
// injizierbar (N6). `pnpm test lib/deploy` läuft so ohne echten Spawn / Port-Bind.
//
// Run:
//   NODE_OPTIONS=--experimental-require-module node_modules/.bin/vitest run \
//     lib/deploy/__tests__/serve-local.test.ts

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  portForWorkspace,
  serveWorkspaceStatic,
  inspectPort,
  __resetServeStateForTests,
  __setServeDepsForTests,
  __peekServedForTests,
} from "@/lib/deploy/serve-local";

afterEach(() => {
  __resetServeStateForTests(); // setzt auch deps → realDeps zurück
  delete process.env.LAZYOS_SERVE_LOCAL;
  delete process.env.LAZYOS_TAILNET_HOST;
});

describe("portForWorkspace — deterministischer Port-Hash", () => {
  it("liegt immer im Range 4300–4399", () => {
    const samples = [
      "ws-website",
      "WS-01KSJG5T358QPGPDM023WRC8FR",
      "demo-pv",
      "",
      "a",
      "ein-sehr-langer-workspace-identifier-mit-vielen-zeichen-xyz",
    ];
    for (const ws of samples) {
      const p = portForWorkspace(ws);
      expect(p).toBeGreaterThanOrEqual(4300);
      expect(p).toBeLessThanOrEqual(4399);
      expect(Number.isInteger(p)).toBe(true);
    }
  });

  it("ist stabil (gleiche workspaceId ⇒ gleicher Port) — Re-Serve-Determinismus", () => {
    const ws = "WS-01KSJG5T358QPGPDM023WRC8FR";
    expect(portForWorkspace(ws)).toBe(portForWorkspace(ws));
    expect(portForWorkspace("ws-website")).toBe(portForWorkspace("ws-website"));
  });

  it("verteilt verschiedene Workspaces (kein Kollaps auf einen Port)", () => {
    const ports = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      ports.add(portForWorkspace(`ws-${i}`));
    }
    // Bei 50 distinkten Inputs über 100 Slots erwarten wir deutliche Streuung.
    expect(ports.size).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inspectPort — reine Zustandslogik (healthy / free / zombie) über injizierte I/O
// ─────────────────────────────────────────────────────────────────────────────
describe("inspectPort — Port-Zustand vor dem Spawn", () => {
  it("GESUND: Probe grün ⇒ kind=healthy, KEIN Holder-Lookup, KEIN Kill", async () => {
    const portHolderPids = vi.fn(async () => [] as number[]);
    const killPid = vi.fn(async () => true);
    __setServeDepsForTests({
      probePort: async () => true,
      portHolderPids,
      killPid,
    });
    const state = await inspectPort(4321);
    expect(state.kind).toBe("healthy");
    // Bei gesundem Port wird gar nicht erst nach Haltern gesucht/gekillt.
    expect(portHolderPids).not.toHaveBeenCalled();
    expect(killPid).not.toHaveBeenCalled();
  });

  it("FREI: Probe rot + keine Halter ⇒ kind=free, kein Kill", async () => {
    const killPid = vi.fn(async () => true);
    __setServeDepsForTests({
      probePort: async () => false,
      portHolderPids: async () => [],
      killPid,
    });
    const state = await inspectPort(4321);
    expect(state.kind).toBe("free");
    expect(killPid).not.toHaveBeenCalled();
  });

  it("ZOMBIE: Probe rot + Halter vorhanden ⇒ killt JEDEN Halter", async () => {
    const killed: number[] = [];
    __setServeDepsForTests({
      probePort: async () => false,
      portHolderPids: async () => [4242, 4243],
      killPid: async (pid: number) => {
        killed.push(pid);
        return true;
      },
      sleep: async () => {},
    });
    const state = await inspectPort(4321);
    expect(state.kind).toBe("zombie");
    if (state.kind === "zombie") {
      expect(state.killedPids).toEqual([4242, 4243]);
    }
    expect(killed).toEqual([4242, 4243]);
  });

  it("ZOMBIE: meldet Überlebende, wenn der Re-Check den Port noch belegt sieht", async () => {
    __setServeDepsForTests({
      probePort: async () => false,
      portHolderPids: async () => [9999], // bleibt belegt (nicht killbar)
      killPid: async () => false, // EPERM
      sleep: async () => {},
    });
    const state = await inspectPort(4321);
    expect(state.kind).toBe("zombie");
    if (state.kind === "zombie") {
      expect(state.killedPids).toEqual([]);
      expect(state.survivors).toEqual([9999]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// serveWorkspaceStatic — restart-robuste Idempotenz + Health-Verifikation
// ─────────────────────────────────────────────────────────────────────────────
describe("serveWorkspaceStatic — Restart-robuste Idempotenz", () => {
  it("GESUNDER Port (z.B. nach Server-Restart, Map leer) ⇒ Wiederverwendung OHNE Spawn", async () => {
    const spawnHttpServer = vi.fn(() => ({ pid: 1 }));
    __setServeDepsForTests({
      probePort: async () => true, // Port antwortet schon (alter Prozess lebt)
      spawnHttpServer,
      sleep: async () => {},
    });

    const res = await serveWorkspaceStatic({
      repoPath: "/tmp/ws",
      workspaceId: "ws-restart",
    });

    expect(res.spawned).toBe(false); // KEIN Doppel-Spawn
    expect(res.healthy).toBe(true);
    expect(spawnHttpServer).not.toHaveBeenCalled(); // <-- kern: kein EADDRINUSE-Risiko
    expect(res.note).toContain("wiederverwendet");
    // Map wurde rehydriert (überlebt sonst keinen Restart).
    expect(__peekServedForTests("ws-restart")).not.toBeNull();
  });

  it("zwei aufeinanderfolgende Läufe (Re-Merge) spawnen NICHT doppelt", async () => {
    let portIsLive = false;
    const spawnHttpServer = vi.fn(() => {
      portIsLive = true; // nach dem ersten Spawn antwortet der Port
      return { pid: 4711 };
    });
    __setServeDepsForTests({
      probePort: async () => portIsLive,
      portHolderPids: async () => [],
      spawnHttpServer,
      sleep: async () => {},
    });

    const first = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-rm" });
    const second = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-rm" });

    expect(first.spawned).toBe(true);
    expect(first.healthy).toBe(true);
    expect(second.spawned).toBe(false); // Re-Merge reused denselben gesunden Serve
    expect(second.healthy).toBe(true);
    expect(spawnHttpServer).toHaveBeenCalledTimes(1); // genau EIN Spawn
  });
});

describe("serveWorkspaceStatic — Zombie-Kill statt EADDRINUSE", () => {
  it("toter Port-Halter wird gekillt, DANN gespawnt", async () => {
    const killed: number[] = [];
    let portIsLive = false;
    const spawnHttpServer = vi.fn(() => {
      portIsLive = true;
      return { pid: 5555 };
    });
    let probeCalls = 0;
    __setServeDepsForTests({
      // 1. Probe (inspectPort) rot (Zombie), spätere Probes folgen portIsLive.
      probePort: async () => {
        probeCalls += 1;
        return probeCalls === 1 ? false : portIsLive;
      },
      portHolderPids: async () => (portIsLive ? [] : [8080]), // belegt bis Kill+Spawn
      killPid: async (pid: number) => {
        killed.push(pid);
        return true;
      },
      spawnHttpServer,
      sleep: async () => {},
    });

    const res = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-zombie" });

    expect(killed).toContain(8080); // Zombie wurde gekillt
    expect(spawnHttpServer).toHaveBeenCalledTimes(1); // nach dem Kill neu gespawnt
    expect(res.spawned).toBe(true);
    expect(res.healthy).toBe(true);
    expect(res.note).toContain("gekillt");
  });
});

describe("serveWorkspaceStatic — health-verifizierter spawned/healthy", () => {
  it("Spawn, aber Port antwortet NIE ⇒ healthy=false + ehrliche note (nicht blind true)", async () => {
    __setServeDepsForTests({
      probePort: async () => false, // bleibt rot — Port kommt nie hoch
      portHolderPids: async () => [],
      spawnHttpServer: () => ({ pid: 6001 }),
      sleep: async () => {},
    });

    const res = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-dead" });

    expect(res.spawned).toBe(true); // wir HABEN gespawnt …
    expect(res.healthy).toBe(false); // … aber ehrlich: nicht erreichbar
    expect(res.note).toMatch(/antwortet.*nicht|nicht.*erreichbar/i);
  });

  it("Spawn-Fehler (kein npx) ⇒ spawned=false, healthy=false, note erklärt es", async () => {
    __setServeDepsForTests({
      probePort: async () => false,
      portHolderPids: async () => [],
      spawnHttpServer: () => {
        throw new Error("spawn npx ENOENT");
      },
      sleep: async () => {},
    });

    const res = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-nonpx" });

    expect(res.spawned).toBe(false); // kein echter Spawn → ehrlich false
    expect(res.healthy).toBe(false);
    expect(res.note).toContain("http-server spawn failed");
    // Lokale URL kommt trotzdem (fail-soft) — Caller kann sie anbieten.
    expect(res.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("wirft NIE — auch wenn JEDE injizierte I/O-Op wirft (fail-soft)", async () => {
    __setServeDepsForTests({
      probePort: async () => {
        throw new Error("probe boom");
      },
      portHolderPids: async () => {
        throw new Error("lsof boom");
      },
      killPid: async () => {
        throw new Error("kill boom");
      },
      spawnHttpServer: () => {
        throw new Error("spawn boom");
      },
      sleep: async () => {},
    });

    await expect(
      serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-chaos" }),
    ).resolves.toMatchObject({ port: expect.any(Number), localUrl: expect.any(String) });
  });
});

describe("serveWorkspaceStatic — Tailscale (LAZYOS_SERVE_LOCAL)", () => {
  it("OHNE Flag: KEIN tailscale-Spawn, publicUrl=null", async () => {
    const spawnTailscaleServe = vi.fn(() => ({ pid: 1 }));
    __setServeDepsForTests({
      probePort: async () => true, // reuse-Pfad, kürzeste Bahn
      spawnTailscaleServe,
      sleep: async () => {},
    });
    const res = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-nots" });
    expect(spawnTailscaleServe).not.toHaveBeenCalled();
    expect(res.publicUrl).toBeNull();
  });

  it("MIT Flag + Host: idempotenter tailscale-Aufruf + deterministische publicUrl auf Workspace-Port", async () => {
    process.env.LAZYOS_SERVE_LOCAL = "on";
    process.env.LAZYOS_TAILNET_HOST = "demo-host.tail1234.ts.net";
    const spawnTailscaleServe = vi.fn(() => ({ pid: 2 }));
    __setServeDepsForTests({
      probePort: async () => true, // gesund → reuse, dann tailscale re-apply
      spawnTailscaleServe,
      sleep: async () => {},
    });
    const ws = "ws-tailscale";
    const port = portForWorkspace(ws);
    const res = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: ws });
    // tailscale serve ist deklarativ → auch bei Reuse erneut angewandt (Restart-Heilung).
    expect(spawnTailscaleServe).toHaveBeenCalledTimes(1);
    expect(res.publicUrl).toBe(`https://demo-host.tail1234.ts.net:${port}`);
    // NIE 443.
    expect(res.publicUrl).not.toContain(":443");
  });

  it("MIT Flag ohne Host: note erklärt fehlenden LAZYOS_TAILNET_HOST, publicUrl=null", async () => {
    process.env.LAZYOS_SERVE_LOCAL = "on";
    __setServeDepsForTests({
      probePort: async () => true,
      spawnTailscaleServe: () => ({ pid: 3 }),
      sleep: async () => {},
    });
    const res = await serveWorkspaceStatic({ repoPath: "/tmp/ws", workspaceId: "ws-nohost" });
    expect(res.publicUrl).toBeNull();
    expect(res.note).toContain("LAZYOS_TAILNET_HOST");
  });
});
