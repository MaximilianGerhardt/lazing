// Connector-Detection tests — ACL5-A · 2026-05-24.
//
// Tests cover:
//   (a) Bekannter Provider im Katalog → provider gesetzt, confidence = 1.0.
//   (b) Provider-Hint erkannt aber KEIN Katalog-Eintrag → missing = 'profile'.
//   (c) Kein Connector-Bezug → missing = 'no-connector', provider = null.
//   (d) Provider + Capabilities korrekt extrahiert (Keyword-Heuristik).
//   (e) Deterministisch: gleicher Input → gleicher Output (mehrfach aufgerufen).
//   (f) hasCredential-Callback: 'none' wenn true, 'credential' wenn false/absent.
//   (g) LLM-Fallback-Stub: classifyWithLlmFallback gibt Ergebnis unverändert zurück.
//
// Strategy:
//   - `vi.mock('@/lib/connectors/catalog')` injiziert ein In-Memory-Fake-Katalog
//     ohne DB-Zugriff. detectConnector() ist dadurch vollständig testbar ohne SQLite.
//   - detectConnector() selbst ist N6-deterministisch (kein I/O, kein async).
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/connectors/__tests__/detect.test.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  detectConnector,
  classifyWithLlmFallback,
  type ConnectorDetection,
  type DetectContext,
} from "../detect";

// ---------------------------------------------------------------------------
// Mock: catalog.ts — In-Memory-Fake-Katalog (kein SQLite nötig)
// ---------------------------------------------------------------------------

vi.mock("@/lib/connectors/catalog", () => {
  const mockRows = [
    {
      id: "CONN-heygen",
      provider: "heygen",
      displayName: "HeyGen Video API",
      description: "AI video rendering with avatars",
      authKind: "api_key",
      baseUrl: "https://api.heygen.com",
      apiVersion: "v2",
      docsUrl: null,
      source: "manual",
      validatedAt: null,
      contentHash: "abc123",
      createdAt: 1000,
      updatedAt: 2000,
    },
    {
      id: "CONN-stripe",
      provider: "stripe",
      displayName: "Stripe Payments",
      description: "Payment processing",
      authKind: "api_key",
      baseUrl: "https://api.stripe.com",
      apiVersion: "v1",
      docsUrl: null,
      source: "manual",
      validatedAt: null,
      contentHash: "def456",
      createdAt: 1000,
      updatedAt: 2000,
    },
    {
      id: "CONN-instagram",
      provider: "instagram",
      displayName: "Instagram Graph API",
      description: "Post media to Instagram",
      authKind: "oauth",
      baseUrl: "https://graph.facebook.com",
      apiVersion: "v19.0",
      docsUrl: null,
      source: "manual",
      validatedAt: null,
      contentHash: "ghi789",
      createdAt: 1000,
      updatedAt: 2000,
    },
  ];

  const mockCapabilities: Record<string, { id: string; connectorId: string; name: string; description: string | null; inputSchemaJson: null; outputSchemaJson: null; mcpToolName: null; required: boolean }[]> = {
    "CONN-heygen": [
      { id: "CAP-1", connectorId: "CONN-heygen", name: "render_video", description: null, inputSchemaJson: null, outputSchemaJson: null, mcpToolName: null, required: true },
      { id: "CAP-2", connectorId: "CONN-heygen", name: "list_avatars", description: null, inputSchemaJson: null, outputSchemaJson: null, mcpToolName: null, required: false },
    ],
    "CONN-stripe": [
      { id: "CAP-3", connectorId: "CONN-stripe", name: "create_payment", description: null, inputSchemaJson: null, outputSchemaJson: null, mcpToolName: null, required: true },
      { id: "CAP-4", connectorId: "CONN-stripe", name: "list_invoices", description: null, inputSchemaJson: null, outputSchemaJson: null, mcpToolName: null, required: false },
    ],
    "CONN-instagram": [
      { id: "CAP-5", connectorId: "CONN-instagram", name: "post_media", description: null, inputSchemaJson: null, outputSchemaJson: null, mcpToolName: null, required: true },
      { id: "CAP-6", connectorId: "CONN-instagram", name: "list_posts", description: null, inputSchemaJson: null, outputSchemaJson: null, mcpToolName: null, required: false },
    ],
  };

  return {
    listConnectors: vi.fn(() => mockRows),
    getConnectorProfile: vi.fn((provider: string) => {
      return mockRows.find((r) => r.provider === provider) ?? null;
    }),
    listCapabilities: vi.fn((provider: string) => {
      const row = mockRows.find((r) => r.provider === provider);
      if (!row) return [];
      return mockCapabilities[row.id] ?? [];
    }),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const baseCtx: DetectContext = { workspaceId: "ws-test-001" };

// ---------------------------------------------------------------------------
// (a) Bekannter Provider im Katalog → provider gesetzt
// ---------------------------------------------------------------------------

describe("(a) bekannter Provider im Katalog → provider gesetzt", () => {
  it("exakter Provider-Slug im Prompt → provider = 'heygen', confidence = 1.0", () => {
    const result = detectConnector("Erstelle ein Video mit heygen für den Kunden", baseCtx);

    expect(result.provider).toBe("heygen");
    expect(result.confidence).toBe(1.0);
    expect(result.missing).not.toBe("no-connector");
    expect(result.missing).not.toBe("profile");
    expect(result.rationale).toContain("Provider-Slug/DisplayName-Match");
  });

  it("DisplayName 'HeyGen' im Prompt → provider = 'heygen', confidence = 1.0", () => {
    const result = detectConnector("Kann ich mit HeyGen Video API einen Avatar rendern?", baseCtx);

    expect(result.provider).toBe("heygen");
    expect(result.confidence).toBe(1.0);
  });

  it("Stripe Provider-Slug → provider = 'stripe', confidence = 1.0", () => {
    const result = detectConnector("Erstelle eine Stripe-Zahlung für 49 EUR", baseCtx);

    expect(result.provider).toBe("stripe");
    expect(result.confidence).toBe(1.0);
  });

  it("Capabilities aus Katalog werden extrahiert (render_video + list_avatars)", () => {
    const result = detectConnector("Rendere ein heygen-Video", baseCtx);

    expect(result.neededCapabilities).toContain("render_video");
    expect(result.neededCapabilities).toContain("list_avatars");
  });

  it("Instagram direkter Slug-Match → provider = 'instagram', confidence = 1.0", () => {
    const result = detectConnector("Poste das Bild auf instagram", baseCtx);

    expect(result.provider).toBe("instagram");
    expect(result.confidence).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// (b) Provider-Hint erkannt aber kein Katalog-Eintrag → missing = 'profile'
// ---------------------------------------------------------------------------

describe("(b) Provider erkannt aber kein Katalog-Eintrag → missing = 'profile'", () => {
  it("github-Keyword ohne github im Katalog → provider = 'github', missing = 'profile'", () => {
    const result = detectConnector("Erstelle ein pull request auf github", baseCtx);

    // 'github' ist nicht im Fake-Katalog → missing = 'profile'
    expect(result.provider).toBe("github");
    expect(result.missing).toBe("profile");
    expect(result.rationale).toContain("KEIN Eintrag in connector_catalog");
  });

  it("openai-Keyword ohne openai im Katalog → provider = 'openai', missing = 'profile'", () => {
    const result = detectConnector("Use the OpenAI GPT-4 chat completion endpoint", baseCtx);

    expect(result.provider).toBe("openai");
    expect(result.missing).toBe("profile");
  });

  it("slack-Keyword ohne slack im Katalog → provider = 'slack', missing = 'profile'", () => {
    const result = detectConnector("Sende eine Slack-Nachricht in den #dev-Kanal", baseCtx);

    expect(result.provider).toBe("slack");
    expect(result.missing).toBe("profile");
    expect(result.confidence).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// (c) Kein Connector-Bezug → missing = 'no-connector'
// ---------------------------------------------------------------------------

describe("(c) kein Connector-Bezug → missing = 'no-connector'", () => {
  it("generische Chat-Anfrage ohne API-Bezug", () => {
    const result = detectConnector("Was ist der Unterschied zwischen REST und GraphQL?", baseCtx);

    expect(result.provider).toBeNull();
    expect(result.missing).toBe("no-connector");
    expect(result.confidence).toBe(0);
  });

  it("Coding-Anfrage ohne externen Connector", () => {
    const result = detectConnector("Schreibe eine TypeScript-Funktion die zwei Arrays merged", baseCtx);

    expect(result.provider).toBeNull();
    expect(result.missing).toBe("no-connector");
  });

  it("leerer Prompt", () => {
    const result = detectConnector("", baseCtx);

    expect(result.provider).toBeNull();
    expect(result.missing).toBe("no-connector");
    expect(result.confidence).toBe(0);
  });

  it("Markdown-Text ohne Connector-Signal", () => {
    const result = detectConnector("# Dokumentation\n\nDas ist ein Abschnitt über Architektur.", baseCtx);

    expect(result.provider).toBeNull();
    expect(result.missing).toBe("no-connector");
  });
});

// ---------------------------------------------------------------------------
// (d) Provider + Capabilities korrekt extrahiert
// ---------------------------------------------------------------------------

describe("(d) Capabilities korrekt extrahiert", () => {
  it("Heygen: render_video + list_avatars aus Katalog", () => {
    const result = detectConnector("Erstelle einen heygen Avatar-Video", baseCtx);

    expect(result.provider).toBe("heygen");
    expect(result.neededCapabilities).toContain("render_video");
    expect(result.neededCapabilities).toContain("list_avatars");
  });

  it("Stripe: create_payment + list_invoices aus Katalog + Heuristik", () => {
    const result = detectConnector("Erstelle eine stripe Zahlung für den Kunden", baseCtx);

    expect(result.provider).toBe("stripe");
    expect(result.neededCapabilities).toContain("create_payment");
    expect(result.neededCapabilities).toContain("list_invoices");
  });

  it("Video-Keyword (kein Katalog-Hit): neededCapabilities enthält render_video", () => {
    // 'video' trifft heygen-Keyword-Regel; heygen ist IM Katalog → confidence 0.7
    const result = detectConnector("Render ein Video mit Avataren", baseCtx);

    // heygen ist im Fake-Katalog, daher entweder 0.7 (keyword) oder 1.0 (slug)
    expect(result.neededCapabilities).toContain("render_video");
  });

  it("E-Mail-Keyword ohne Katalog-Eintrag: capabilities = ['send_email'], no-connector", () => {
    const result = detectConnector("Sende eine E-Mail an den Kunden mit sendgrid", baseCtx);

    // 'sendgrid' ist nicht im Fake-Katalog, hat aber keinen providerHint im Rule
    // E-Mail-Regel trifft → capabilities [send_email]
    expect(result.neededCapabilities).toContain("send_email");
  });

  it("rationale ist non-empty und enthält N6-Marker", () => {
    const result = detectConnector("heygen Video rendern", baseCtx);

    expect(result.rationale.length).toBeGreaterThan(10);
    expect(result.rationale).toContain("N6-deterministisch");
  });
});

// ---------------------------------------------------------------------------
// (e) Deterministisch: gleicher Input → gleicher Output
// ---------------------------------------------------------------------------

describe("(e) Deterministisch: gleicher Input → gleicher Output", () => {
  it("heygen-Prompt 5x aufgerufen → immer gleiches Ergebnis", () => {
    const prompt = "Erstelle ein heygen-Video für den neuen Kunden";
    const results: ConnectorDetection[] = [];

    for (let i = 0; i < 5; i++) {
      results.push(detectConnector(prompt, baseCtx));
    }

    for (const r of results) {
      expect(r.provider).toBe(results[0].provider);
      expect(r.confidence).toBe(results[0].confidence);
      expect(r.missing).toBe(results[0].missing);
      expect(r.neededCapabilities).toEqual(results[0].neededCapabilities);
      expect(r.rationale).toBe(results[0].rationale);
    }
  });

  it("no-connector-Prompt 3x aufgerufen → immer no-connector", () => {
    const prompt = "Was ist ein gutes TypeScript-Designmuster?";

    const r1 = detectConnector(prompt, baseCtx);
    const r2 = detectConnector(prompt, baseCtx);
    const r3 = detectConnector(prompt, baseCtx);

    expect(r1.missing).toBe("no-connector");
    expect(r2.missing).toBe("no-connector");
    expect(r3.missing).toBe("no-connector");

    expect(r1.provider).toBeNull();
    expect(r2.provider).toBeNull();
    expect(r3.provider).toBeNull();
  });

  it("gleicher Prompt + unterschiedliche workspaceId (ohne hasCredential) → gleicher provider/confidence", () => {
    const prompt = "Sende via stripe eine Rechnung";

    const r1 = detectConnector(prompt, { workspaceId: "ws-a" });
    const r2 = detectConnector(prompt, { workspaceId: "ws-b" });

    // workspaceId beeinflusst NICHT provider/confidence/capabilities
    expect(r1.provider).toBe(r2.provider);
    expect(r1.confidence).toBe(r2.confidence);
    expect(r1.neededCapabilities).toEqual(r2.neededCapabilities);
  });
});

// ---------------------------------------------------------------------------
// (f) hasCredential-Callback: missing = 'none' / 'credential'
// ---------------------------------------------------------------------------

describe("(f) hasCredential-Callback steuert missing-Status", () => {
  it("hasCredential returns true → missing = 'none'", () => {
    const ctx: DetectContext = {
      workspaceId: "ws-test",
      hasCredential: (_provider) => true,
    };

    const result = detectConnector("Erstelle ein heygen-Video", ctx);

    expect(result.provider).toBe("heygen");
    expect(result.missing).toBe("none");
  });

  it("hasCredential returns false → missing = 'credential'", () => {
    const ctx: DetectContext = {
      workspaceId: "ws-test",
      hasCredential: (_provider) => false,
    };

    const result = detectConnector("Erstelle ein heygen-Video", ctx);

    expect(result.provider).toBe("heygen");
    expect(result.missing).toBe("credential");
  });

  it("kein hasCredential (default) → missing = 'credential' (konservativ)", () => {
    const result = detectConnector("Erstelle ein heygen-Video", baseCtx);

    expect(result.provider).toBe("heygen");
    expect(result.missing).toBe("credential");
  });

  it("hasCredential wird mit dem korrekt gematchen Provider aufgerufen", () => {
    const calledWith: string[] = [];

    const ctx: DetectContext = {
      workspaceId: "ws-check",
      hasCredential: (provider) => {
        calledWith.push(provider);
        return true;
      },
    };

    detectConnector("stripe zahlung erstellen", ctx);

    expect(calledWith).toContain("stripe");
  });
});

// ---------------------------------------------------------------------------
// (g) classifyWithLlmFallback — Stub gibt Ergebnis unverändert zurück
// ---------------------------------------------------------------------------

describe("(g) classifyWithLlmFallback Stub", () => {
  it("Stub gibt denselben provider wie fallback zurück", () => {
    const fallback: ConnectorDetection = {
      provider: null,
      neededCapabilities: [],
      confidence: 0,
      missing: "no-connector",
      rationale: "N6-deterministisch: Kein Connector-Bezug erkannt.",
    };

    const result = classifyWithLlmFallback("Irgendein Prompt", fallback, baseCtx);

    expect(result.provider).toBe(fallback.provider);
    expect(result.missing).toBe(fallback.missing);
    expect(result.confidence).toBe(fallback.confidence);
  });

  it("Stub-Rationale enthält 'LLM-Fallback (stub'", () => {
    const fallback: ConnectorDetection = {
      provider: null,
      neededCapabilities: [],
      confidence: 0,
      missing: "no-connector",
      rationale: "N6-deterministisch: Kein Connector-Bezug erkannt.",
    };

    const result = classifyWithLlmFallback("test", fallback, baseCtx);

    expect(result.rationale).toContain("LLM-Fallback (stub");
  });
});
