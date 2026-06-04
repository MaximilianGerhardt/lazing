// Invoke-Policy Gate Tests (S4, ACL-5-C) — 2026-05-24.
//
// Tests cover:
//   (a) Capability nicht im Profil → assertCallAllowed wirft.
//   (b) K1-RAG-Tool angefragt → denied, nie in allowedMcpTools.
//   (c) File/Bash-Tool nie in allowedMcpTools (structural invariant).
//   (d) Trust-Default 'ask' — via buildHardenedToolset + assertCallAllowed.
//   (e) Provider-Namespace-Check: Tool eines anderen Providers → denied.
//   (f) Leeres requestedCaps → leeres Toolset (nicht denied).
//   (g) Gültiger Call (Capability im Profil, kein K1, richtiger Provider) → allowed.
//   (h) hasFileTool Hilfsfunktion.
//   (i) CallDeniedError hat code-Feld.
//
// Kein DB-Zugriff — invoke-policy.ts ist pure.
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/connectors/__tests__/invoke-policy.test.ts

import { describe, expect, it } from "vitest";

import {
  CallDeniedError,
  assertCallAllowed,
  buildHardenedToolset,
  hasFileTool,
  type ConnectorProfile,
} from "../invoke-policy";

// ─── Test-Profile ─────────────────────────────────────────────────────────────

const HEYGEN_PROFILE: ConnectorProfile = {
  provider: "heygen",
  capabilities: [
    { name: "render_video", mcpToolName: "mcp__heygen__render_video" },
    { name: "list_avatars", mcpToolName: "mcp__heygen__list_avatars" },
    { name: "get_status", mcpToolName: "mcp__heygen__get_status" },
    // REST-only capability ohne MCP-Tool
    { name: "webhook_ping", mcpToolName: null },
  ],
};

const K1_PROFILE: ConnectorProfile = {
  provider: "local-rag",
  capabilities: [
    // K1-RAG-Tool — muss immer geblockt werden
    { name: "search", mcpToolName: "mcp__local-rag__search" },
    { name: "index", mcpToolName: "mcp__local-rag__index" },
  ],
};

// Finding 3a: realer Connector mit Capability-Name ≠ Tool-Name.
// cap 'list_avatars' → tool 'mcp__heygen__avatars_list' (umgedrehte Reihenfolge),
// cap 'render_video' → tool 'mcp__heygen__create_video' (anderes Verb).
const DIVERGENT_NAME_PROFILE: ConnectorProfile = {
  provider: "heygen",
  capabilities: [
    { name: "list_avatars", mcpToolName: "mcp__heygen__avatars_list" },
    { name: "render_video", mcpToolName: "mcp__heygen__create_video" },
  ],
};

const CROSS_PROVIDER_PROFILE: ConnectorProfile = {
  provider: "heygen",
  capabilities: [
    // Bösartiges Profil: Capability zeigt auf Tool eines anderen Providers
    { name: "render_video", mcpToolName: "mcp__openai__embeddings" },
    // Legitimes Tool
    { name: "list_avatars", mcpToolName: "mcp__heygen__list_avatars" },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("invoke-policy S4 Gate — ACL-5-C", () => {
  // ── (a) Capability nicht im Profil → denied ───────────────────────────────

  describe("(a) Capability nicht im Profil → denied + assertCallAllowed wirft", () => {
    it("Capability 'unknown_cap' nicht im Profil → deniedMcpTools enthält sie", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["unknown_cap"],
      );
      expect(toolset.allowedMcpTools).toHaveLength(0);
      expect(toolset.deniedMcpTools).toContain("unknown_cap");
    });

    it("assertCallAllowed wirft für Capability die nicht im allowedMcpTools ist", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["unknown_cap"],
      );
      expect(() =>
        assertCallAllowed("heygen", "unknown_cap", toolset),
      ).toThrow(CallDeniedError);
    });

    it("assertCallAllowed hat code 'no-allowed-tools' wenn Toolset leer", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["unknown_cap"],
      );
      expect(() =>
        assertCallAllowed("heygen", "unknown_cap", toolset),
      ).toThrow(
        expect.objectContaining({ code: "no-allowed-tools" }),
      );
    });
  });

  // ── (b) K1-RAG-Tool → denied ─────────────────────────────────────────────

  describe("(b) K1-RAG-Tool angefragt → nie in allowedMcpTools", () => {
    it("mcp__local-rag__search wird durch K1 blockiert", () => {
      const toolset = buildHardenedToolset(
        "local-rag",
        K1_PROFILE,
        ["search"],
      );
      expect(toolset.allowedMcpTools).not.toContain("mcp__local-rag__search");
      expect(toolset.deniedMcpTools).toContain("mcp__local-rag__search");
    });

    it("mcp__local-rag__index wird durch K1 blockiert", () => {
      const toolset = buildHardenedToolset(
        "local-rag",
        K1_PROFILE,
        ["index"],
      );
      expect(toolset.allowedMcpTools).not.toContain("mcp__local-rag__index");
      expect(toolset.deniedMcpTools).toContain("mcp__local-rag__index");
    });

    it("mcp__standards-rag__* wird durch K1 blockiert (wildcard-Match)", () => {
      const profile: ConnectorProfile = {
        provider: "standards-rag",
        capabilities: [
          { name: "lookup", mcpToolName: "mcp__standards-rag__lookup" },
        ],
      };
      const toolset = buildHardenedToolset("standards-rag", profile, ["lookup"]);
      expect(toolset.allowedMcpTools).not.toContain("mcp__standards-rag__lookup");
      expect(toolset.deniedMcpTools).toContain("mcp__standards-rag__lookup");
    });

    it("mcp__*-global-rag__* wird durch K1 blockiert (compound wildcard)", () => {
      const profile: ConnectorProfile = {
        provider: "my-global-rag",
        capabilities: [
          { name: "search", mcpToolName: "mcp__my-global-rag__search" },
        ],
      };
      const toolset = buildHardenedToolset("my-global-rag", profile, ["search"]);
      expect(toolset.allowedMcpTools).not.toContain("mcp__my-global-rag__search");
      expect(toolset.deniedMcpTools).toContain("mcp__my-global-rag__search");
    });

    it("K1-Deny ist nicht überschreibbar — auch wenn Capability korrekt registriert ist", () => {
      // Selbst wenn ein Operator ein K1-Tool explizit registriert: es bleibt geblockt.
      const toolset = buildHardenedToolset(
        "local-rag",
        K1_PROFILE,
        ["search", "index"],
      );
      expect(toolset.allowedMcpTools).toHaveLength(0);
      expect(toolset.deniedMcpTools).toHaveLength(2);
    });
  });

  // ── (c) File/Bash-Tools nie in allowedMcpTools ───────────────────────────

  describe("(c) File/Bash-Tools strukturell nie in allowedMcpTools", () => {
    const fileToolNames = ["Read", "Write", "Edit", "Bash", "Shell", "Exec", "Grep", "Glob", "LS", "MultiEdit"];

    for (const tool of fileToolNames) {
      it(`${tool} taucht nie in allowedMcpTools auf`, () => {
        // Auch wenn ein bösartiges Profil ein File-Tool als mcpToolName setzt:
        const profile: ConnectorProfile = {
          provider: "heygen",
          capabilities: [
            { name: "render_video", mcpToolName: tool },
          ],
        };
        const toolset = buildHardenedToolset("heygen", profile, ["render_video"]);
        // Provider-Namespace-Check blockiert das bereits (kein 'mcp__heygen__'-Präfix).
        // Zusätzlich: hasFileTool soll false für allowedMcpTools sein.
        expect(hasFileTool(toolset.allowedMcpTools)).toBe(false);
        expect(toolset.allowedMcpTools).not.toContain(tool);
      });
    }

    it("allowedFileTools ist immer ein leeres Array (structural: readonly never[])", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["render_video"],
      );
      expect(toolset.allowedFileTools).toHaveLength(0);
      expect(Array.isArray(toolset.allowedFileTools)).toBe(true);
    });
  });

  // ── (d) Provider-Namespace-Check ──────────────────────────────────────────

  describe("(d) Provider-Namespace-Check: Tool eines anderen Providers → denied", () => {
    it("Cross-Provider-Tool 'mcp__openai__embeddings' für heygen-Capability wird blockiert", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        CROSS_PROVIDER_PROFILE,
        ["render_video"],
      );
      expect(toolset.allowedMcpTools).not.toContain("mcp__openai__embeddings");
      expect(toolset.deniedMcpTools).toContain("mcp__openai__embeddings");
    });

    it("Legitimes Tool bleibt erlaubt auch wenn andere Capability cross-provider ist", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        CROSS_PROVIDER_PROFILE,
        ["list_avatars"],
      );
      expect(toolset.allowedMcpTools).toContain("mcp__heygen__list_avatars");
    });
  });

  // ── (e) REST-only Capability (kein mcpToolName) → denied ─────────────────

  describe("(e) REST-only Capability ohne MCP-Tool → denied", () => {
    it("Capability mit mcpToolName=null wird denied", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["webhook_ping"],
      );
      expect(toolset.allowedMcpTools).not.toContain("webhook_ping");
      expect(toolset.deniedMcpTools).toContain("webhook_ping");
    });
  });

  // ── (f) Leeres requestedCaps → leeres Toolset ─────────────────────────────

  describe("(f) Leeres requestedCaps → leeres Toolset (kein Error)", () => {
    it("keine requestedCaps → leeres allowedMcpTools, keine Denied", () => {
      const toolset = buildHardenedToolset("heygen", HEYGEN_PROFILE, []);
      expect(toolset.allowedMcpTools).toHaveLength(0);
      expect(toolset.deniedMcpTools).toHaveLength(0);
    });
  });

  // ── (g) Gültiger Call → allowed ───────────────────────────────────────────

  describe("(g) Gültiger Connector-Call → allowed", () => {
    it("render_video für heygen mit korrektem Profil → in allowedMcpTools", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["render_video"],
      );
      expect(toolset.allowedMcpTools).toContain("mcp__heygen__render_video");
      expect(toolset.deniedMcpTools).not.toContain("mcp__heygen__render_video");
    });

    it("assertCallAllowed wirft NICHT für erlaubte Capability", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["render_video"],
      );
      expect(() =>
        assertCallAllowed("heygen", "render_video", toolset),
      ).not.toThrow();
    });

    it("mehrere Capabilities — nur die erlaubten landen in allowed", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["render_video", "list_avatars", "get_status", "unknown_cap"],
      );
      expect(toolset.allowedMcpTools).toContain("mcp__heygen__render_video");
      expect(toolset.allowedMcpTools).toContain("mcp__heygen__list_avatars");
      expect(toolset.allowedMcpTools).toContain("mcp__heygen__get_status");
      expect(toolset.deniedMcpTools).toContain("unknown_cap");
    });
  });

  // ── (g2) Finding 3a: Capability-Name ≠ Tool-Name (capabilityToTool-Map) ────

  describe("(g2) Finding 3a — Capability-Name divergiert von Tool-Name", () => {
    it("buildHardenedToolset baut capabilityToTool-Map mit divergenten Namen korrekt", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        DIVERGENT_NAME_PROFILE,
        ["list_avatars", "render_video"],
      );
      expect(toolset.capabilityToTool["list_avatars"]).toBe(
        "mcp__heygen__avatars_list",
      );
      expect(toolset.capabilityToTool["render_video"]).toBe(
        "mcp__heygen__create_video",
      );
      // Beide Tools sind in allowedMcpTools (Provider-Namespace stimmt).
      expect(toolset.allowedMcpTools).toContain("mcp__heygen__avatars_list");
      expect(toolset.allowedMcpTools).toContain("mcp__heygen__create_video");
    });

    it("assertCallAllowed ERLAUBT cap 'list_avatars' obwohl tool 'avatars_list' heißt (kein Tail-Match-Bug)", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        DIVERGENT_NAME_PROFILE,
        ["list_avatars"],
      );
      // Alter Tail-Match hätte hier geworfen (tail 'avatars_list' !== cap 'list_avatars').
      expect(() =>
        assertCallAllowed("heygen", "list_avatars", toolset),
      ).not.toThrow();
    });

    it("assertCallAllowed ERLAUBT cap 'render_video' obwohl tool 'create_video' heißt", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        DIVERGENT_NAME_PROFILE,
        ["render_video"],
      );
      expect(() =>
        assertCallAllowed("heygen", "render_video", toolset),
      ).not.toThrow();
    });

    it("assertCallAllowed WIRFT für unbekannte cap auch bei divergenten Namen (fail-closed)", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        DIVERGENT_NAME_PROFILE,
        ["list_avatars"],
      );
      // 'render_video' wurde NICHT angefordert → nicht in der Map → wirft.
      expect(() =>
        assertCallAllowed("heygen", "render_video", toolset),
      ).toThrow(
        expect.objectContaining({ code: "capability-not-resolved" }),
      );
    });

    it("assertCallAllowed WIRFT wenn capabilityToTool-Tool nicht in allowedMcpTools (manipulierte Map, defense-in-depth)", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        DIVERGENT_NAME_PROFILE,
        ["list_avatars"],
      );
      // Map manipulieren: cap zeigt auf ein Tool das NICHT in allowedMcpTools ist.
      toolset.capabilityToTool["list_avatars"] = "mcp__heygen__not_allowed";
      expect(() =>
        assertCallAllowed("heygen", "list_avatars", toolset),
      ).toThrow(
        expect.objectContaining({ code: "capability-not-resolved" }),
      );
    });

    it("assertCallAllowed WIRFT wenn capabilityToTool-Tool fremden Provider-Namespace hat (manipulierte Map)", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        DIVERGENT_NAME_PROFILE,
        ["list_avatars"],
      );
      // Tool in allowedMcpTools schmuggeln, aber mit fremdem Provider.
      toolset.allowedMcpTools.push("mcp__openai__exfiltrate");
      toolset.capabilityToTool["list_avatars"] = "mcp__openai__exfiltrate";
      expect(() =>
        assertCallAllowed("heygen", "list_avatars", toolset),
      ).toThrow(
        expect.objectContaining({ code: "capability-not-resolved" }),
      );
    });
  });

  // ── (h) hasFileTool Hilfsfunktion ──────────────────────────────────────────

  describe("(h) hasFileTool", () => {
    it("gibt false für leere Liste zurück", () => {
      expect(hasFileTool([])).toBe(false);
    });

    it("gibt false für legitime MCP-Tools zurück", () => {
      expect(
        hasFileTool(["mcp__heygen__render_video", "mcp__heygen__list_avatars"]),
      ).toBe(false);
    });

    it("gibt true für Bash zurück", () => {
      expect(hasFileTool(["Bash"])).toBe(true);
    });

    it("gibt true für Read zurück", () => {
      expect(hasFileTool(["Read", "mcp__heygen__render_video"])).toBe(true);
    });
  });

  // ── (i) assertCallAllowed — fehlende Argumente ────────────────────────────

  describe("(i) assertCallAllowed — fehlende Argumente", () => {
    it("wirft mit code 'missing-args' bei leerem provider", () => {
      const toolset = buildHardenedToolset("heygen", HEYGEN_PROFILE, ["render_video"]);
      expect(() => assertCallAllowed("", "render_video", toolset)).toThrow(
        expect.objectContaining({ code: "missing-args" }),
      );
    });

    it("wirft mit code 'missing-args' bei leerer capability", () => {
      const toolset = buildHardenedToolset("heygen", HEYGEN_PROFILE, ["render_video"]);
      expect(() => assertCallAllowed("heygen", "", toolset)).toThrow(
        expect.objectContaining({ code: "missing-args" }),
      );
    });

    it("wirft mit code 'provider-not-in-hardened' wenn Toolset falschen Provider hat", () => {
      // Toolset für heygen, aber Call für openai
      const toolset = buildHardenedToolset("heygen", HEYGEN_PROFILE, ["render_video"]);
      expect(() => assertCallAllowed("openai", "embeddings", toolset)).toThrow(
        expect.objectContaining({ code: "provider-not-in-hardened" }),
      );
    });
  });

  // ── S4 Invarianten: fail-closed Zusammenfassung ───────────────────────────

  describe("S4 Invarianten — strukturelle Sicherheits-Garantien", () => {
    it("INV-1: allowedFileTools ist immer leer, egal was im Profil steht", () => {
      for (const profile of [HEYGEN_PROFILE, K1_PROFILE, CROSS_PROVIDER_PROFILE]) {
        const toolset = buildHardenedToolset(
          profile.provider,
          profile,
          profile.capabilities.map((c) => c.name),
        );
        expect(toolset.allowedFileTools).toHaveLength(0);
      }
    });

    it("INV-2: K1-geblockte Tools tauchen nie in allowedMcpTools auf", () => {
      const toolset = buildHardenedToolset(
        "local-rag",
        K1_PROFILE,
        K1_PROFILE.capabilities.map((c) => c.name),
      );
      expect(toolset.allowedMcpTools).toHaveLength(0);
    });

    it("INV-3: buildHardenedToolset ist eine pure Funktion — gleiche Eingabe → gleiche Ausgabe", () => {
      const r1 = buildHardenedToolset("heygen", HEYGEN_PROFILE, ["render_video"]);
      const r2 = buildHardenedToolset("heygen", HEYGEN_PROFILE, ["render_video"]);
      expect(r1.allowedMcpTools).toEqual(r2.allowedMcpTools);
      expect(r1.deniedMcpTools).toEqual(r2.deniedMcpTools);
      expect(r1.rationale).toEqual(r2.rationale);
    });

    it("INV-4: leerer provider → leeres Toolset (kein Crash)", () => {
      const toolset = buildHardenedToolset("", HEYGEN_PROFILE, ["render_video"]);
      expect(toolset.allowedMcpTools).toHaveLength(0);
    });

    it("INV-5: capabilityToTool-Werte sind exakt die allowedMcpTools (kein Drift)", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        DIVERGENT_NAME_PROFILE,
        ["list_avatars", "render_video"],
      );
      const mappedTools = Object.values(toolset.capabilityToTool).sort();
      const allowed = [...toolset.allowedMcpTools].sort();
      expect(mappedTools).toEqual(allowed);
    });

    it("INV-6: denied Capabilities tauchen nie in capabilityToTool auf", () => {
      const toolset = buildHardenedToolset(
        "heygen",
        HEYGEN_PROFILE,
        ["render_video", "webhook_ping", "unknown_cap"],
      );
      // webhook_ping (REST-only) + unknown_cap sind denied → nicht in der Map.
      expect(toolset.capabilityToTool["webhook_ping"]).toBeUndefined();
      expect(toolset.capabilityToTool["unknown_cap"]).toBeUndefined();
      expect(toolset.capabilityToTool["render_video"]).toBe(
        "mcp__heygen__render_video",
      );
    });
  });
});
