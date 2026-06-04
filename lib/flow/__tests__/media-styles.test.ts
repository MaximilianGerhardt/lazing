// Flow Studio — Medien-Stil-Optionen tests (Stream B2 · 2026-05-27).
//
// Deckt lib/flow/media-styles.ts ab:
//   (a) mediaStepKindFromSkill: tool:image|video|avatar → kind; sonst null.
//   (b) mediaStyleOptions: korrekte Optionen je Typ; Higgsfield als Video-Option
//       ERREICHBAR (Befund: war 0× erreichbar); Provider/Capabilities = kanonische
//       P5-Werte; connector-Invariante (provider+caps nur bei approach='connector').
//   (c) resolveMediaStyle / applyStyleChoice: 'procedural'/'css'/'placeholder' →
//       needsConnector=false; higgsfield → needsConnector=true + provider/caps;
//       fremde optionId → MediaStyleError.
//   (d) buildMediaStyleChoicePayload + renderMediaStyleChoiceSurface: Renderer-
//       Format (options:[{id,label,sublabel,primary?}]) + parser-kompatibles Markup.
//
// Run:
//   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
//     lib/flow/__tests__/media-styles.test.ts

import { describe, expect, it } from "vitest";

import { P5_CAPABILITY_KEYS } from "@/lib/connectors/p5-tool-connectors";
import {
  buildMediaStyleChoicePayload,
  findMediaStyleOption,
  mediaStepKindFromSkill,
  mediaStyleOptions,
  MediaStyleError,
  renderMediaStyleChoiceSurface,
  resolveMediaStyle,
  type MediaStyleOption,
} from "@/lib/flow/media-styles";

describe("media-styles — mediaStepKindFromSkill", () => {
  it("mappt tool:image|video|avatar auf den Medien-Schritt-Typ", () => {
    expect(mediaStepKindFromSkill("tool:image")).toBe("image");
    expect(mediaStepKindFromSkill("tool:video")).toBe("video");
    expect(mediaStepKindFromSkill("tool:avatar")).toBe("avatar");
  });

  it("liefert null für Nicht-Medien-Skills", () => {
    expect(mediaStepKindFromSkill("architecture")).toBeNull();
    expect(mediaStepKindFromSkill("copywriting")).toBeNull();
    expect(mediaStepKindFromSkill("coder")).toBeNull();
    expect(mediaStepKindFromSkill(null)).toBeNull();
    expect(mediaStepKindFromSkill(undefined)).toBeNull();
  });
});

/** Prüft die N2-Invariante: connector ⇔ provider+caps, sonst beides leer. */
function assertConnectorInvariant(o: MediaStyleOption): void {
  if (o.approach === "connector") {
    expect(o.provider, `${o.id}: connector braucht provider`).toBeTruthy();
    expect(
      (o.neededCapabilities ?? []).length,
      `${o.id}: connector braucht caps`,
    ).toBeGreaterThan(0);
  } else {
    expect(o.provider, `${o.id}: non-connector ohne provider`).toBeUndefined();
    expect(
      (o.neededCapabilities ?? []).length,
      `${o.id}: non-connector ohne caps`,
    ).toBe(0);
  }
}

describe("media-styles — mediaStyleOptions je Typ", () => {
  it("video: enthält Higgsfield (connector), Stockfootage, Scroll-Animation, Prozedural", () => {
    const opts = mediaStyleOptions("video");
    const byId = new Map(opts.map((o) => [o.id, o]));

    // Owner-SOLL: eigenes Video / Stockfootage / Scroll-Down-Animation /
    // Higgsfield / prozedural — alle als Optionen vorhanden.
    expect(byId.has("video-higgsfield")).toBe(true);
    expect(byId.has("video-stockfootage")).toBe(true);
    expect(byId.has("video-scroll-animation")).toBe(true);
    expect(byId.has("video-procedural")).toBe(true);

    // Higgsfield ERREICHBAR als Video-Option (Befund: war 0× erreichbar).
    const hf = byId.get("video-higgsfield")!;
    expect(hf.approach).toBe("connector");
    expect(hf.provider).toBe("higgsfield");
    expect(hf.neededCapabilities).toEqual([P5_CAPABILITY_KEYS.higgsfield]);
    expect(hf.neededCapabilities).toEqual(["video.motion"]);

    // Ansätze korrekt zugeordnet.
    expect(byId.get("video-scroll-animation")!.approach).toBe("css");
    expect(byId.get("video-procedural")!.approach).toBe("procedural");
    expect(byId.get("video-stockfootage")!.approach).toBe("placeholder");

    for (const o of opts) assertConnectorInvariant(o);
  });

  it("image: KI-generiert (imagegen2), Stockfoto, Platzhalter", () => {
    const opts = mediaStyleOptions("image");
    const byId = new Map(opts.map((o) => [o.id, o]));

    expect(byId.has("image-imagegen2")).toBe(true);
    expect(byId.has("image-stockphoto")).toBe(true);
    expect(byId.has("image-placeholder")).toBe(true);

    const gen = byId.get("image-imagegen2")!;
    expect(gen.approach).toBe("connector");
    expect(gen.provider).toBe("imagegen2");
    expect(gen.neededCapabilities).toEqual([P5_CAPABILITY_KEYS.imagegen2]);
    expect(gen.neededCapabilities).toEqual(["image.generate"]);

    for (const o of opts) assertConnectorInvariant(o);
  });

  it("avatar: Sprecher-Avatar (heygen-avatar) + kein Avatar", () => {
    const opts = mediaStyleOptions("avatar");
    const byId = new Map(opts.map((o) => [o.id, o]));

    expect(byId.has("avatar-heygen")).toBe(true);
    expect(byId.has("avatar-none")).toBe(true);

    const hg = byId.get("avatar-heygen")!;
    expect(hg.approach).toBe("connector");
    expect(hg.provider).toBe("heygen-avatar");
    expect(hg.neededCapabilities).toEqual([P5_CAPABILITY_KEYS.heygenAvatar]);
    expect(hg.neededCapabilities).toEqual(["video.avatar"]);

    expect(byId.get("avatar-none")!.approach).toBe("placeholder");

    for (const o of opts) assertConnectorInvariant(o);
  });
});

describe("media-styles — findMediaStyleOption", () => {
  it("findet eine Option per id innerhalb des Typs", () => {
    expect(findMediaStyleOption("video", "video-higgsfield")?.provider).toBe(
      "higgsfield",
    );
  });

  it("liefert null für eine fremde/unbekannte id (N2: keine stille Akzeptanz)", () => {
    expect(findMediaStyleOption("video", "image-imagegen2")).toBeNull();
    expect(findMediaStyleOption("video", "does-not-exist")).toBeNull();
  });
});

describe("media-styles — resolveMediaStyle / Connector-Bedarf", () => {
  it("higgsfield → needsConnector=true + provider + caps", () => {
    const r = resolveMediaStyle("video", "video-higgsfield");
    expect(r.needsConnector).toBe(true);
    expect(r.provider).toBe("higgsfield");
    expect(r.neededCapabilities).toEqual(["video.motion"]);
    expect(r.option.label).toBe("Eigenes Video (Higgsfield)");
  });

  it("procedural → needsConnector=false, kein Provider/keine Caps", () => {
    const r = resolveMediaStyle("video", "video-procedural");
    expect(r.needsConnector).toBe(false);
    expect(r.provider).toBeNull();
    expect(r.neededCapabilities).toEqual([]);
  });

  it("css (Scroll-Animation) → needsConnector=false", () => {
    expect(resolveMediaStyle("video", "video-scroll-animation").needsConnector).toBe(
      false,
    );
  });

  it("placeholder (Stockfootage / kein Avatar) → needsConnector=false", () => {
    expect(resolveMediaStyle("video", "video-stockfootage").needsConnector).toBe(
      false,
    );
    expect(resolveMediaStyle("avatar", "avatar-none").needsConnector).toBe(false);
  });

  it("fremde optionId → MediaStyleError('unknown_option')", () => {
    expect(() => resolveMediaStyle("video", "image-imagegen2")).toThrowError(
      MediaStyleError,
    );
    try {
      resolveMediaStyle("video", "nope");
    } catch (e) {
      expect((e as MediaStyleError).code).toBe("unknown_option");
    }
  });
});

describe("media-styles — quickchoice-Payload + Markup", () => {
  it("buildMediaStyleChoicePayload → Renderer-Format (id/label/sublabel + primary auf der ersten)", () => {
    const payload = buildMediaStyleChoicePayload({
      flowId: "FLOW-x",
      stepId: "FSTEP-1",
      stepTitle: "Hero-Video für die Startseite",
      stepKind: "video",
    });

    expect(payload.variant).toBe("quickchoice");
    expect(payload.stepId).toBe("FSTEP-1");
    expect(payload.stepTitle).toBe("Hero-Video für die Startseite"); // N1 verbatim
    expect(payload.stepKind).toBe("video");
    expect(payload.flowId).toBe("FLOW-x");

    // Optionen im exakt vom Renderer erwarteten Format ({id,label,sublabel}).
    expect(payload.options.length).toBe(mediaStyleOptions("video").length);
    for (const o of payload.options) {
      expect(typeof o.id).toBe("string");
      expect(typeof o.label).toBe("string");
      expect(typeof o.sublabel).toBe("string");
    }
    // Higgsfield erreichbar im Payload + erste Option als primary.
    expect(payload.options[0].id).toBe("video-higgsfield");
    expect(payload.options[0].primary).toBe(true);
    expect(payload.options.some((o) => o.id === "video-higgsfield")).toBe(true);
    // Folge-Optionen NICHT primary.
    expect(payload.options[1].primary).toBeUndefined();
  });

  it("renderMediaStyleChoiceSurface → parser-kompatibles <surface:prompt>-Markup", () => {
    const payload = buildMediaStyleChoicePayload({
      flowId: "FLOW-x",
      stepId: "FSTEP-1",
      stepTitle: "Hero-Video",
      stepKind: "video",
    });
    const markup = renderMediaStyleChoiceSurface(payload);
    expect(markup.startsWith("<surface:prompt>")).toBe(true);
    expect(markup.endsWith("</surface:prompt>")).toBe(true);
    // Der JSON-Kern ist round-trip-fähig (variant=quickchoice).
    const json = markup.slice(
      "<surface:prompt>".length,
      -"</surface:prompt>".length,
    );
    const parsed = JSON.parse(json);
    expect(parsed.variant).toBe("quickchoice");
    expect(Array.isArray(parsed.options)).toBe(true);
  });

  // Phase 1 Track AB · Befund A (2026-05-29): Flow-Style-Quickchoice MUSS
  // `behavior: 'event-only'` tragen, sonst löst der Klick zwei Aktionen aus
  // (reply + Window-Event) und das Re-Post an /api/flow/compose-and-run
  // wird durch eine konkurrierende Chat-Nachricht zerstört.
  it("buildMediaStyleChoicePayload → behavior='event-only' (Befund-A-Fix, Doppelrouting verhindern)", () => {
    const payload = buildMediaStyleChoicePayload({
      flowId: "FLOW-eh-website",
      stepId: "FSTEP-hero",
      stepTitle: "Hero-Video",
      stepKind: "video",
    });
    expect(payload.behavior).toBe("event-only");

    // Round-trip durch das Surface-Markup → Renderer-Payload trägt das Feld.
    const markup = renderMediaStyleChoiceSurface(payload);
    const json = markup.slice(
      "<surface:prompt>".length,
      -"</surface:prompt>".length,
    );
    const parsed = JSON.parse(json);
    expect(parsed.behavior).toBe("event-only");
  });
});
