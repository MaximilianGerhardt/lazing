// Intent → Flow-Template Komposition tests — Flow Studio P2 · 2026-05-27.
//
// Strategy: in-memory better-sqlite3 DB, Schema aus den ECHTEN Migrationen via
// readFileSync (kein getDb()-Singleton, kein vi.mock). composeFlowFromIntent
// nimmt — wie die gesamte Flow-Surface — ein rohes Database-Handle. Wir laden:
//   - 0112 flow_studio          (flow_templates/steps/runs — Persistenz-Ziel)
//   - 0101 connector_catalog    (connector_catalog/connector_capabilities)
//   - 0100 api_credentials      (Credential-Existenz-Check)
//
// decompose wird als STUB injiziert (keine echte LLM-Abhängigkeit). Der Stub
// bildet "Erstelle eine Webseite" → Aufbau/Copy/Design/Fotos/Video/Avatar ab.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/compose.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assignSkill,
  composeFlowFromIntent,
  FlowComposeError,
  type DecomposedStep,
} from "@/lib/flow/compose";
import { listFlowSteps } from "@/lib/flow/templates-repo";
import { dispatchFlow } from "@/lib/flow/execute";

const MIG = (f: string) => path.join(process.cwd(), "db", "migrations", f);

const MIGRATIONS = [
  "0112_flow_studio.sql",
  "0101_connector_catalog.sql",
  "0100_api_credentials.sql",
  // für den dispatchFlow-Roundtrip am Ende:
  "0009_workstreams.sql",
  "0051_workstream_intent.sql",
  "0094_recursive_plans.sql",
  "0107_plan_step_allowed_tools.sql",
  "0110_plan_step_deps_group.sql",
];

function freshDb(): import("better-sqlite3").Database {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = OFF");
  for (const f of MIGRATIONS) {
    const sql = readFileSync(MIG(f), "utf8");
    try {
      raw.exec(sql);
    } catch (err) {
      // ALTER TABLE ADD COLUMN (0110) ist nicht idempotent → per-statement,
      // duplicate-column geschluckt (analog execute.test.ts / db/client.ts).
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(msg)) throw err;
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim())) {
        if (!stmt || stmt.startsWith("--")) continue;
        try {
          raw.exec(stmt);
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          if (!/duplicate column name/i.test(m)) throw e;
        }
      }
    }
  }
  return raw;
}

/** Seedet einen voll-verbundenen Connector (Profil + Capabilities + Credential). */
function seedConnectedConnector(
  raw: import("better-sqlite3").Database,
  opts: {
    provider: string;
    capabilities: string[];
    workspaceId: string;
  },
): void {
  const connId = `CONN-${opts.provider}`;
  raw
    .prepare(
      `INSERT INTO connector_catalog
         (id, provider, display_name, description, auth_kind, base_url,
          api_version, docs_url, source, validated_at, content_hash,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'api_key', ?, 'v1', NULL, 'manual', NULL, '', ?, ?)`,
    )
    .run(
      connId,
      opts.provider,
      `${opts.provider} API`,
      `${opts.provider} test connector`,
      `https://api.${opts.provider}.test`,
      Date.now(),
      Date.now(),
    );
  for (const cap of opts.capabilities) {
    raw
      .prepare(
        `INSERT INTO connector_capabilities
           (id, connector_id, name, description, required)
         VALUES (?, ?, ?, NULL, 1)`,
      )
      .run(`CAP-${opts.provider}-${cap}`, connId, cap);
  }
  // Credential (encrypted_secret/content_hash sind Test-Dummies — nie entschlüsselt).
  raw
    .prepare(
      `INSERT INTO api_credentials
         (id, scope_kind, scope_id, provider, credential_kind, encrypted_secret,
          config_json, last_validated_at, content_hash, created_at, updated_at)
       VALUES (?, 'workspace', ?, ?, 'api_key', 'iv:ct:tag', NULL, NULL, '', ?, ?)`,
    )
    .run(
      `CRED-${opts.provider}`,
      opts.workspaceId,
      opts.provider,
      Date.now(),
      Date.now(),
    );
}

/** Stub-Decompose: "Erstelle eine Webseite" → 6 typische Schritte. */
const websiteDecompose = (): DecomposedStep[] => [
  { title: "Aufbau der Seitenstruktur", rationale: "Information-Architektur + Routing festlegen" },
  { title: "Copy für die Startseite", rationale: "Headline + Body-Texte schreiben" },
  { title: "Design des visuellen Stils", rationale: "Farben, Typo, Komponenten gestalten" },
  { title: "Fotos für die Hero-Section", rationale: "Bilder generieren" },
  { title: "Video-Teaser fürs Reel", rationale: "Motion-Clip rendern" },
  { title: "Avatar-Begrüßung", rationale: "Talking-Head-Presenter erzeugen" },
];

const WS = "ws-flow-1";

describe("flow compose — assignSkill (Heuristik)", () => {
  it("Aufbau/Struktur → architecture (kein Tool)", () => {
    const a = assignSkill("Aufbau der Seitenstruktur");
    expect(a.skill).toBe("architecture");
    expect(a.toolKind).toBeNull();
  });

  it("Copy/Text → copywriting (kein Tool)", () => {
    expect(assignSkill("Copy für die Startseite").skill).toBe("copywriting");
    expect(assignSkill("Texte für das Impressum").skill).toBe("copywriting");
  });

  it("Design → design (kein Tool)", () => {
    expect(assignSkill("Design des visuellen Stils").skill).toBe("design");
  });

  it("Foto/Bild → tool:image mit Provider-Hint imagegen2", () => {
    const a = assignSkill("Fotos für die Hero-Section");
    expect(a.skill).toBe("tool:image");
    expect(a.toolKind).toBe("connector");
    expect(a.providerHint).toBe("imagegen2");
    expect(a.neededCapabilities).toContain("image.generate");
  });

  it("Video/Motion → tool:video mit Provider-Hint higgsfield", () => {
    const a = assignSkill("Video-Teaser fürs Reel");
    expect(a.skill).toBe("tool:video");
    expect(a.providerHint).toBe("higgsfield");
  });

  it("Avatar → tool:avatar mit Provider-Hint heygen (vor Video)", () => {
    const a = assignSkill("Avatar-Begrüßung");
    expect(a.skill).toBe("tool:avatar");
    expect(a.providerHint).toBe("heygen-avatar");
  });

  it("Unbekannt → coder Fallback (kein Tool)", () => {
    const a = assignSkill("Irgendwas Generisches");
    expect(a.skill).toBe("coder");
    expect(a.toolKind).toBeNull();
  });
});

describe("flow compose — composeFlowFromIntent", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("Intent + Stub-Decompose → persistiertes Template + Steps mit korrekten Skills", async () => {
    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      decompose: websiteDecompose,
    });

    // Template persistiert (N1: name = Intent verbatim).
    expect(res.template.id).toMatch(/^FLOW-/);
    expect(res.template.name).toBe("Erstelle eine Webseite");
    expect(res.template.workspaceId).toBe(WS);

    // Steps persistiert in decompose-Ordnung mit korrekten Skills.
    // W1.2 (2026-05-30): bei website-Intent wird ein finaler assembly-Step
    // angehängt → 6 Decompose-Steps + 1 Assembly = 7.
    expect(res.steps).toHaveLength(7);
    expect(res.steps.map((s) => s.skill)).toEqual([
      "architecture",
      "copywriting",
      "design",
      "tool:image",
      "tool:video",
      "tool:avatar",
      "assembly",
    ]);
    // Titel verbatim (N1).
    expect(res.steps[0].label).toBe("Aufbau der Seitenstruktur");
    // rationale wandert verbatim ins configJson (N1).
    expect(JSON.parse(res.steps[1].configJson!).rationale).toBe(
      "Headline + Body-Texte schreiben",
    );

    // depends_on = lineare Kette (jeder hängt am Vorgänger).
    expect(res.steps[0].dependsOnJson).toBeNull();
    expect(JSON.parse(res.steps[1].dependsOnJson!)).toEqual([res.steps[0].id]);
    expect(JSON.parse(res.steps[5].dependsOnJson!)).toEqual([res.steps[4].id]);
    // W1.2: der Assembly-Step hängt am letzten Decompose-Step.
    expect(JSON.parse(res.steps[6].dependsOnJson!)).toEqual([res.steps[5].id]);

    // Re-Lesen aus der DB bestätigt die Persistenz.
    const reread = listFlowSteps(raw, res.template.id);
    expect(reread).toHaveLength(7);
    expect(reread.map((s) => s.skill)).toEqual(res.steps.map((s) => s.skill));
  });

  it("missingTools listet die unverbundenen Tool-Steps (Foto/Video/Avatar, kein Katalog)", async () => {
    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      decompose: websiteDecompose,
    });

    // 3 Tool-Steps, alle unverbunden (kein Connector im Katalog) → reason 'profile'.
    expect(res.missingTools).toHaveLength(3);
    const byProvider = new Map(res.missingTools.map((m) => [m.provider, m]));
    expect(byProvider.get("imagegen2")?.reason).toBe("profile");
    expect(byProvider.get("higgsfield")?.reason).toBe("profile");
    expect(byProvider.get("heygen-avatar")?.reason).toBe("profile");

    // Jeder MissingTool trägt eine echte step.id (für die Credential-Surface).
    for (const m of res.missingTools) {
      expect(m.stepId).toMatch(/^FSTEP-/);
      expect(res.steps.some((s) => s.id === m.stepId)).toBe(true);
    }

    // Nicht-Tool-Steps (Aufbau/Copy/Design) tauchen NICHT in missingTools auf.
    const missingTitles = res.missingTools.map((m) => m.stepTitle);
    expect(missingTitles).not.toContain("Aufbau der Seitenstruktur");
    expect(missingTitles).not.toContain("Copy für die Startseite");
  });

  it("verbundener Connector (imagegen2) → NICHT in missingTools", async () => {
    // imagegen2 voll verbunden: Profil + image.generate-Capability + Credential.
    seedConnectedConnector(raw, {
      provider: "imagegen2",
      capabilities: ["image.generate"],
      workspaceId: WS,
    });

    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      decompose: websiteDecompose,
    });

    // imagegen2 ist verbunden → NICHT missing. Video + Avatar bleiben missing.
    const providers = res.missingTools.map((m) => m.provider);
    expect(providers).not.toContain("imagegen2");
    expect(providers).toContain("higgsfield");
    expect(providers).toContain("heygen-avatar");
    expect(res.missingTools).toHaveLength(2);
  });

  it("Profil + Capability ok, aber kein Credential → reason 'credential'", async () => {
    // imagegen2 hat Profil + Capability, ABER kein Credential im Vault.
    const connId = "CONN-imagegen2";
    raw
      .prepare(
        `INSERT INTO connector_catalog
           (id, provider, display_name, auth_kind, api_version, source,
            content_hash, created_at, updated_at)
         VALUES (?, 'imagegen2', 'imagegen2 API', 'api_key', 'v1', 'manual', '', ?, ?)`,
      )
      .run(connId, Date.now(), Date.now());
    raw
      .prepare(
        `INSERT INTO connector_capabilities (id, connector_id, name, required)
         VALUES (?, ?, 'image.generate', 1)`,
      )
      .run("CAP-imagegen2-gen", connId);

    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      decompose: websiteDecompose,
    });
    const img = res.missingTools.find((m) => m.provider === "imagegen2");
    expect(img?.reason).toBe("credential");
  });

  it("Profil ohne passende Capability → reason 'capability' (fail-closed, N2)", async () => {
    // imagegen2 hat ein Profil + Credential, aber NUR eine irrelevante Capability.
    const connId = "CONN-imagegen2";
    raw
      .prepare(
        `INSERT INTO connector_catalog
           (id, provider, display_name, auth_kind, api_version, source,
            content_hash, created_at, updated_at)
         VALUES (?, 'imagegen2', 'imagegen2 API', 'api_key', 'v1', 'manual', '', ?, ?)`,
      )
      .run(connId, Date.now(), Date.now());
    raw
      .prepare(
        `INSERT INTO connector_capabilities (id, connector_id, name, required)
         VALUES (?, ?, 'list_styles', 0)`,
      )
      .run("CAP-imagegen2-styles", connId);
    raw
      .prepare(
        `INSERT INTO api_credentials
           (id, scope_kind, scope_id, provider, credential_kind, encrypted_secret,
            content_hash, created_at, updated_at)
         VALUES ('CRED-img', 'workspace', ?, 'imagegen2', 'api_key', 'iv:ct:tag', '', ?, ?)`,
      )
      .run(WS, Date.now(), Date.now());

    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      decompose: websiteDecompose,
    });
    const img = res.missingTools.find((m) => m.provider === "imagegen2");
    expect(img?.reason).toBe("capability");
  });

  it("injizierter hasCredential gewinnt über die Default-DB-Query", async () => {
    // imagegen2 Profil + Capability vorhanden, KEIN Credential in der DB —
    // aber der injizierte hasCredential meldet 'verbunden'.
    seedConnectedConnectorWithoutCredential(raw, {
      provider: "imagegen2",
      capabilities: ["image.generate"],
    });

    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      decompose: websiteDecompose,
      hasCredential: (provider) => provider === "imagegen2",
    });
    const providers = res.missingTools.map((m) => m.provider);
    expect(providers).not.toContain("imagegen2");
  });

  it("Ausgabe ist direkt dispatchFlow-fähig (P2-Roundtrip)", async () => {
    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      decompose: websiteDecompose,
    });
    const dispatched = dispatchFlow(raw, {
      flowId: res.template.id,
      workspaceId: WS,
    });
    expect(dispatched.runId).toMatch(/^FRUN-/);
    expect(dispatched.workstreamId).toMatch(/^WS-/);
    const planSteps = raw
      .prepare(
        `SELECT title, step_index FROM workstream_plan_steps
           WHERE workstream_id = ? ORDER BY step_index ASC`,
      )
      .all(dispatched.workstreamId) as Array<Record<string, unknown>>;
    // W1.2: 6 Decompose-Steps + 1 angehängter Assembly-Step = 7.
    expect(planSteps).toHaveLength(7);
    expect(planSteps[0].title).toBe("Aufbau der Seitenstruktur");
    expect(planSteps[6].title).toContain("index.html");
  });

  it("leerer Intent → FlowComposeError invalid_intent", async () => {
    await expect(
      composeFlowFromIntent(raw, {
        intent: "   ",
        workspaceId: WS,
        decompose: websiteDecompose,
      }),
    ).rejects.toThrow(FlowComposeError);
  });

  it("weder decompose noch callEngine → FlowComposeError no_decompose", async () => {
    await expect(
      composeFlowFromIntent(raw, { intent: "Bau X", workspaceId: WS }),
    ).rejects.toThrow(/no_decompose|decompose/);
  });

  it("decompose liefert 0 Schritte → FlowComposeError empty_decompose (kein Template)", async () => {
    let caught: unknown;
    try {
      await composeFlowFromIntent(raw, {
        intent: "Leer",
        workspaceId: WS,
        decompose: () => [],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FlowComposeError);
    expect((caught as FlowComposeError).code).toBe("empty_decompose");
    // Kein verwaistes Template geschrieben (decompose läuft VOR jedem Write).
    expect(
      (raw.prepare("SELECT COUNT(*) c FROM flow_templates").get() as { c: number }).c,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A3 — WHY-Einspeisung (Self-Learning / WARUM-Engine · 2026-05-27).
//
// Der optionale `whyContext`-Input wird — NUR beim Default-Decompose
// (makeRecursivePlanDecompose über callEngine) — dem proposePlan-Prompt
// vorangestellt. Wir prüfen das über einen callEngine-Spy, der den empfangenen
// Prompt festhält und valides Plan-JSON zurückgibt (damit parseProposedPlan ihn
// akzeptiert — N6: Validator bleibt davor). OHNE den Flag = bit-identischer
// Prompt (keine Verhaltensänderung für bestehende Default-Caller).
// ---------------------------------------------------------------------------

/** Minimal-valides ProposedPlan-JSON (3 Steps, ein Tool-Step) für parseProposedPlan. */
const PLAN_JSON = JSON.stringify({
  estimatedComplexity: "M",
  steps: [
    {
      index: 1,
      title: "Aufbau der Seitenstruktur",
      rationale: "IA festlegen",
      targetFiles: ["app/page.tsx"],
      subagentRole: "architect",
    },
    {
      index: 2,
      title: "Copy für die Startseite",
      rationale: "Texte schreiben",
      targetFiles: ["content.md"],
      subagentRole: "coder",
    },
    {
      index: 3,
      title: "Fotos für die Hero-Section",
      rationale: "Bilder generieren",
      targetFiles: ["assets/"],
      subagentRole: "coder",
    },
  ],
});

const WHY_BLOCK = [
  "── Frühere Entscheidungen in diesem Workspace / warum ──",
  "Jüngste Begründungen:",
  "  - [Routing] Higgsfield für Motion gewählt [Agent]",
  "── Ende früherer Kontext (nutze ihn für konsistente, begründete Empfehlungen) ──",
].join("\n");

describe("flow compose — A3 WHY-Einspeisung (whyContext)", () => {
  let raw: import("better-sqlite3").Database;
  beforeEach(() => {
    raw = freshDb();
  });

  it("MIT whyContext (Default-Decompose) → Prompt enthält den WARUM-Block VOR dem Plan-Prompt", async () => {
    const seen: string[] = [];
    const callEngine = async (prompt: string): Promise<string> => {
      seen.push(prompt);
      return PLAN_JSON;
    };

    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      callEngine,
      whyContext: WHY_BLOCK,
    });

    // Decompose lief über den Default-Wrapper → genau 1 Engine-Call.
    expect(seen).toHaveLength(1);
    const prompt = seen[0];
    // Der WARUM-Block ist enthalten …
    expect(prompt).toContain("Frühere Entscheidungen in diesem Workspace");
    expect(prompt).toContain("Higgsfield für Motion gewählt");
    // … und steht VOR dem eigentlichen Plan-Designer-Prompt (Voranstellung).
    expect(prompt.indexOf(WHY_BLOCK)).toBeLessThan(
      prompt.indexOf("Operator-Intent:"),
    );
    // Steps wurden trotzdem normal komponiert + persistiert.
    // W1.2: website-Intent → 3 Decompose-Steps + 1 Assembly = 4.
    expect(res.steps).toHaveLength(4);
    expect(res.steps[3].skill).toBe("assembly");
  });

  it("OHNE whyContext (Default-Decompose) → Prompt bit-identisch zum reinen buildPlanPrompt", async () => {
    const withFlag: string[] = [];
    const withoutFlag: string[] = [];

    await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      callEngine: async (p) => {
        withoutFlag.push(p);
        return PLAN_JSON;
      },
    });
    await composeFlowFromIntent(freshDb(), {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      callEngine: async (p) => {
        withFlag.push(p);
        return PLAN_JSON;
      },
      whyContext: "", // leerer Block → Identitäts-Wrapper
    });

    // Leerer whyContext ⇒ derselbe Prompt wie ganz ohne Flag (bit-identisch).
    expect(withFlag[0]).toBe(withoutFlag[0]);
    // Und kein WARUM-Block ist eingesickert.
    expect(withoutFlag[0]).not.toContain("Frühere Entscheidungen in diesem Workspace");
  });

  it("whyContext wird bei injiziertem decompose IGNORIERT (Caller besitzt seinen Prompt)", async () => {
    // Ein eigener decompose-Stub bekommt NUR den Intent — kein whyContext-Leak.
    const seenIntents: string[] = [];
    const res = await composeFlowFromIntent(raw, {
      intent: "Erstelle eine Webseite",
      workspaceId: WS,
      whyContext: WHY_BLOCK,
      decompose: (intent) => {
        seenIntents.push(intent);
        return websiteDecompose();
      },
    });
    expect(seenIntents).toEqual(["Erstelle eine Webseite"]);
    expect(res.steps.length).toBeGreaterThan(0);
  });
});

/** Wie seedConnectedConnector, aber OHNE Credential (für den hasCredential-Override-Test). */
function seedConnectedConnectorWithoutCredential(
  raw: import("better-sqlite3").Database,
  opts: { provider: string; capabilities: string[] },
): void {
  const connId = `CONN-${opts.provider}`;
  raw
    .prepare(
      `INSERT INTO connector_catalog
         (id, provider, display_name, auth_kind, api_version, source,
          content_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'api_key', 'v1', 'manual', '', ?, ?)`,
    )
    .run(connId, opts.provider, `${opts.provider} API`, Date.now(), Date.now());
  for (const cap of opts.capabilities) {
    raw
      .prepare(
        `INSERT INTO connector_capabilities (id, connector_id, name, required)
         VALUES (?, ?, ?, 1)`,
      )
      .run(`CAP-${opts.provider}-${cap}`, connId, cap);
  }
}
