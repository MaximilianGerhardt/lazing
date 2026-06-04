/**
 * lib/chat/__tests__/intent-flow-classifier.test.ts
 * --------------------------------------------------
 * Tests für lib/chat/intent-flow-classifier.ts.
 *
 * Strategie:
 *   - Positive (DE+EN) — Verb am Anfang, Flow-Objekt, >= minWords.
 *   - Negative — Fragen, kurze Sätze, Lese-Aufträge, Diskussionen.
 *   - Edge — Slash-Präfix raushalten, Höflichkeit abschneiden, leerer Input.
 *   - Synth — buildSyntheticFlowCommand erhält den Originaltext verbatim (N1).
 *
 * Run: `pnpm vitest run lib/chat/__tests__/intent-flow-classifier.test.ts`
 */
import { describe, expect, it } from 'vitest';
import {
  classifyFlowIntent,
  buildSyntheticFlowCommand,
  FLOW_INTENT_PATTERNS,
} from '../intent-flow-classifier';

// ---------------------------------------------------------------------------
// Positive — Deutsch
// ---------------------------------------------------------------------------

describe('classifyFlowIntent · positive · Deutsch', () => {
  it('matches "erstelle eine Webseite mit Hero-Video"', () => {
    const r = classifyFlowIntent('erstelle eine Webseite mit Hero-Video');
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('erstelle');
    expect(r.matchedObject).toBe('webseite');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('matches "Bau mir eine Landingpage für den B2B-Launch"', () => {
    const r = classifyFlowIntent('Bau mir eine Landingpage für den B2B-Launch');
    expect(r.kind).toBe('flow');
    // Multi-word „bau mir" gewinnt vor dem generischen „bau" — Label
    // ist die kanonische Form „baue mir" aus FLOW_VERB_PATTERNS.
    expect(r.matchedVerb).toBe('baue mir');
    expect(r.matchedObject).toBe('landingpage');
  });

  it('matches "generiere ein Brand-Identity-Paket"', () => {
    const r = classifyFlowIntent('generiere ein Brand-Identity-Paket');
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('brand');
  });

  it('matches "designe ein Pitchdeck für das Investoren-Meeting"', () => {
    const r = classifyFlowIntent('designe ein Pitchdeck für das Investoren-Meeting');
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('pitchdeck');
  });

  it('matches "entwickle einen Online-Shop mit Stripe-Checkout"', () => {
    const r = classifyFlowIntent('entwickle einen Online-Shop mit Stripe-Checkout');
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('shop');
  });

  it('matches "mach eine Kampagne für Instagram"', () => {
    const r = classifyFlowIntent('mach eine Kampagne für Instagram');
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('kampagne');
  });

  it('matches with höflichkeits-Präfix "Bitte erstelle eine Webseite zu KI-Beratung"', () => {
    const r = classifyFlowIntent('Bitte erstelle eine Webseite zu KI-Beratung');
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('erstelle');
  });

  it('matches "Hey, bau mir eine App für mein Team"', () => {
    const r = classifyFlowIntent('Hey, bau mir eine App für mein Team');
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('app');
  });
});

// ---------------------------------------------------------------------------
// Positive — Englisch
// ---------------------------------------------------------------------------

describe('classifyFlowIntent · positive · English', () => {
  it('matches "create a landing page for my SaaS"', () => {
    const r = classifyFlowIntent('create a landing page for my SaaS');
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('create');
    expect(r.matchedObject).toBe('landingpage');
  });

  it('matches "build a brand identity for ACME"', () => {
    const r = classifyFlowIntent('build a brand identity for ACME');
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('brand');
  });

  it('matches with politeness "Please generate a pitch deck for Series A"', () => {
    const r = classifyFlowIntent('Please generate a pitch deck for Series A');
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('pitchdeck');
  });
});

// ---------------------------------------------------------------------------
// Negative — Fragen
// ---------------------------------------------------------------------------

describe('classifyFlowIntent · negative · questions', () => {
  it('rejects "Wie erstelle ich eine Webseite?"', () => {
    const r = classifyFlowIntent('Wie erstelle ich eine Webseite?');
    expect(r.kind).toBe('unknown');
    expect(r.reason).toMatch(/wh-question|question/);
  });

  it('rejects "Was ist eine Landingpage?"', () => {
    const r = classifyFlowIntent('Was ist eine Landingpage?');
    expect(r.kind).toBe('unknown');
  });

  it('rejects "How do I build a website?"', () => {
    const r = classifyFlowIntent('How do I build a website?');
    expect(r.kind).toBe('unknown');
  });

  it('rejects pure trailing-? without wh-word: "erstelle eine Webseite?"', () => {
    // Owner kann eine Idee mit Fragezeichen formulieren („machen wir das?")
    // → konservativ NICHT als Flow auslösen.
    const r = classifyFlowIntent('erstelle eine Webseite?');
    expect(r.kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Negative — kurze / mehrdeutige Eingaben
// ---------------------------------------------------------------------------

describe('classifyFlowIntent · negative · too short / ambiguous', () => {
  it('rejects empty input', () => {
    expect(classifyFlowIntent('').kind).toBe('unknown');
    expect(classifyFlowIntent('   ').kind).toBe('unknown');
  });

  it('rejects under min-words "bau das"', () => {
    const r = classifyFlowIntent('bau das');
    expect(r.kind).toBe('unknown');
    expect(r.reason).toMatch(/too short/);
  });

  it('rejects "mach app" (only 2 words, no flow-object resolution either)', () => {
    expect(classifyFlowIntent('mach app').kind).toBe('unknown');
  });

  it('respects custom minWords', () => {
    const tight = classifyFlowIntent('bau eine app', { minWords: 5 });
    expect(tight.kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Negative — Lese/Status/Diskussion
// ---------------------------------------------------------------------------

describe('classifyFlowIntent · negative · read / discuss / meta', () => {
  it('rejects "Lese die Datei x.md"', () => {
    expect(classifyFlowIntent('Lese die Datei x.md').kind).toBe('unknown');
  });

  it('rejects "Zeige mir den Status des Projekts"', () => {
    expect(classifyFlowIntent('Zeige mir den Status des Projekts').kind).toBe('unknown');
  });

  it('rejects "Was war der Status gestern"', () => {
    expect(classifyFlowIntent('Was war der Status gestern').kind).toBe('unknown');
  });

  it('rejects "Was hältst du von der Idee einer Webseite"', () => {
    expect(
      classifyFlowIntent('Was hältst du von der Idee einer Webseite').kind,
    ).toBe('unknown');
  });

  it('rejects "Erkläre mir wie eine Webseite gebaut wird"', () => {
    expect(
      classifyFlowIntent('Erkläre mir wie eine Webseite gebaut wird').kind,
    ).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Negative — kein Flow-Objekt
// ---------------------------------------------------------------------------

describe('classifyFlowIntent · negative · verb without flow-object', () => {
  it('rejects "erstelle einen Eintrag im Kalender"', () => {
    // "erstelle" matcht, aber kein Flow-Objekt → unknown.
    const r = classifyFlowIntent('erstelle einen Eintrag im Kalender');
    expect(r.kind).toBe('unknown');
    expect(r.matchedVerb).toBe('erstelle');
    expect(r.matchedObject).toBeNull();
  });

  it('rejects "baue mir einen Hocker"', () => {
    expect(classifyFlowIntent('baue mir einen Hocker').kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('classifyFlowIntent · edge cases', () => {
  it('rejects inputs already starting with a slash', () => {
    const r = classifyFlowIntent('/flow erstelle eine Webseite');
    expect(r.kind).toBe('unknown');
    expect(r.reason).toMatch(/slash command/);
  });

  it('rejects non-string input (defensive)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(classifyFlowIntent(null as any).kind).toBe('unknown');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(classifyFlowIntent(undefined as any).kind).toBe('unknown');
  });

  it('trims surrounding whitespace before evaluating', () => {
    const r = classifyFlowIntent('   erstelle eine Webseite zu KI-Beratung   ');
    expect(r.kind).toBe('flow');
  });

  it('exposes FLOW_INTENT_PATTERNS for inspection / coverage', () => {
    expect(FLOW_INTENT_PATTERNS.verbs.length).toBeGreaterThan(5);
    expect(FLOW_INTENT_PATTERNS.objects.length).toBeGreaterThan(10);
    expect(FLOW_INTENT_PATTERNS.disqualifiers.length).toBeGreaterThan(3);
  });

  it('exposes new Path-B pattern lists (politeness + inlineVerbs)', () => {
    expect(FLOW_INTENT_PATTERNS.politeness.length).toBeGreaterThan(8);
    expect(FLOW_INTENT_PATTERNS.inlineVerbs.length).toBeGreaterThan(8);
  });
});

// ---------------------------------------------------------------------------
// 2026-05-29 — Slice B: Höflichkeitsform-DE-Patterns (Path B, additiv)
// ---------------------------------------------------------------------------
// Owner-Befund: gestern gebauter Auto-Flow-Classifier griff NICHT auf seinen
// realen Webseiten-Prompt „Ich möchte eine website erstellen weil wir aktuell
// das problem ahben das die dienstleistung …" — wegen konservativem Imperativ-
// am-Satzanfang-Anker. DE-Höflichkeitsformen sind jetzt ein zweiter Match-Pfad.

describe('classifyFlowIntent · politeness-form · Deutsch (Path B)', () => {
  it('matches owner real-world prompt verbatim (Webseite + weil-Erklärung)', () => {
    const ownerPrompt =
      'Ich möchte eine website erstellen weil wir aktuell das problem haben das die dienstleistung nicht klar genug rüberkommt';
    const r = classifyFlowIntent(ownerPrompt);
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('erstellen');
    // Das erste Objekt-Muster, das matcht, gewinnt; `webseite` deckt die
    // englische Variante `website` über `\b(webseite|websites?|...)\b` mit ab.
    expect(r.matchedObject).toBe('webseite');
    expect(r.reason).toMatch(/politeness "ich möchte"/);
    expect(r.reason).toMatch(/object "webseite"/);
  });

  it('matches "Ich möchte eine Landingpage bauen für unser neues Produkt"', () => {
    const r = classifyFlowIntent(
      'Ich möchte eine Landingpage bauen für unser neues Produkt',
    );
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('bauen');
    expect(r.matchedObject).toBe('landingpage');
  });

  it('matches "Wir möchten eine App bauen mit Authentifizierung"', () => {
    const r = classifyFlowIntent('Wir möchten eine App bauen mit Authentifizierung');
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('bauen');
    expect(r.matchedObject).toBe('app');
  });

  it('matches "Ich brauche eine Site für meine Beratungsfirma"', () => {
    const r = classifyFlowIntent('Ich brauche eine Site für meine Beratungsfirma');
    // „brauche" allein ist kein Flow-Verb; aber Owner-Brief sagt: Höflichkeits-
    // form + Object reicht, wenn Object eindeutig Flow-würdig ist? Nein: laut
    // Brief BRAUCHT es das Verb. „Ich brauche eine Site" hat KEIN Flow-Verb
    // (brauchen ist die Höflichkeitsform-Konjugation selbst, kein Build-Verb).
    // Daher: das Object „Site" allein triggert nicht. Wir akzeptieren das als
    // konservative Untergrenze. Wenn der Brief „ich brauche eine Site" als
    // MATCH erwartet, müsste ein impliziter Build-Default in Path B her.
    //
    // Owner-Brief sagt explizit: „Ich brauche eine Site für meine Beratungsfirma"
    // soll MATCHEN. → Path B akzeptiert „brauche/möchte/wollen/will" als
    // implizites Build-Signal, wenn das Object Flow-würdig ist.
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('seite');
  });

  it('matches "lass uns ein Brand-Design machen"', () => {
    const r = classifyFlowIntent('lass uns ein Brand-Design machen');
    expect(r.kind).toBe('flow');
    // Inline-Verb-Scan trifft das frühere `designen`-Pattern (matcht „Design")
    // bevor `machen` an die Reihe kommt — beides sind valide Flow-Verben,
    // erstes Pattern gewinnt.
    expect(r.matchedVerb).toBe('designen');
    expect(r.matchedObject).toBe('brand');
  });

  it('matches "Wir wollen eine Website bauen mit modernem Design"', () => {
    const r = classifyFlowIntent('Wir wollen eine Website bauen mit modernem Design');
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('bauen');
    // s.o. — webseite-Pattern deckt website mit ab und gewinnt.
    expect(r.matchedObject).toBe('webseite');
  });

  it('matches "Ich hätte gern ein Pitchdeck für die Series A"', () => {
    const r = classifyFlowIntent('Ich hätte gern ein Pitchdeck für die Series A');
    // „hätte gern" ist politeness ohne explizites Build-Verb. Wie bei
    // „brauche": Path B akzeptiert das implizite Wunsch-Signal + Flow-Object.
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('pitchdeck');
  });
});

describe('classifyFlowIntent · politeness-form · English (Path B)', () => {
  it('matches "I want to build a website for my consultancy"', () => {
    const r = classifyFlowIntent('I want to build a website for my consultancy');
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('build');
    // webseite-Pattern erfasst auch das englische website (s. Owner-Test).
    expect(r.matchedObject).toBe('webseite');
  });

  it("matches \"we'd like to create a landing page\"", () => {
    const r = classifyFlowIntent("we'd like to create a landing page");
    expect(r.kind).toBe('flow');
    expect(r.matchedVerb).toBe('create');
    expect(r.matchedObject).toBe('landingpage');
  });

  it('matches "I need a landing page for our product launch"', () => {
    const r = classifyFlowIntent('I need a landing page for our product launch');
    // „need" allein ist kein Flow-Verb. Path B akzeptiert das implizite
    // Bedarfs-Signal („i need") + Flow-Object.
    expect(r.kind).toBe('flow');
    expect(r.matchedObject).toBe('landingpage');
  });
});

describe('classifyFlowIntent · politeness-form · disqualifiers stay strict', () => {
  it('rejects polite question "Ich möchte wissen wie eine Webseite gebaut wird"', () => {
    // „möchte" + Object → würde sonst matchen. Aber `wissen` ist kein Flow-
    // Verb und es gibt zwar „gebaut" (Partizip) — wir matchen nur Stamm-Form.
    // Plus: das ist semantisch eine Erklär-Bitte, kein Build-Auftrag.
    const r = classifyFlowIntent(
      'Ich möchte wissen wie eine Webseite gebaut wird',
    );
    expect(r.kind).toBe('unknown');
  });

  it('rejects "Ich möchte verstehen wie Brand-Identity funktioniert"', () => {
    // Höflichkeit + Object „brand-identity" matcht, aber „verstehen" ist
    // kein Flow-Verb → unknown.
    const r = classifyFlowIntent(
      'Ich möchte verstehen wie Brand-Identity funktioniert',
    );
    expect(r.kind).toBe('unknown');
  });

  it('rejects polite question with trailing ?', () => {
    const r = classifyFlowIntent('Ich möchte eine Webseite erstellen?');
    // Trailing ? ist Disqualifier — Frage-Marker, kein Auftrag.
    expect(r.kind).toBe('unknown');
  });

  it('rejects too-short polite input with custom minWords=5', () => {
    // „ich möchte app" wäre mit Default-minWords=3 ein Match (Politeness +
    // Object reichen). Strenger Caller, der z.B. minWords=5 setzt, würde es
    // ablehnen. Default-Verhalten ist bewusst tolerant.
    const r = classifyFlowIntent('ich möchte app', { minWords: 5 });
    expect(r.kind).toBe('unknown');
    expect(r.reason).toMatch(/too short/);
  });
});

describe('classifyFlowIntent · politeness without flow-object', () => {
  it('rejects "Ich möchte einen Eintrag im Kalender erstellen"', () => {
    // Höflichkeit + Verb matchen, aber kein Flow-Object → unknown.
    const r = classifyFlowIntent('Ich möchte einen Eintrag im Kalender erstellen');
    expect(r.kind).toBe('unknown');
    expect(r.matchedObject).toBeNull();
  });

  it('rejects "Wir möchten einen Hocker bauen"', () => {
    const r = classifyFlowIntent('Wir möchten einen Hocker bauen');
    expect(r.kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// buildSyntheticFlowCommand — N1 verbatim
// ---------------------------------------------------------------------------

describe('buildSyntheticFlowCommand', () => {
  it('prepends "/flow " and preserves the original text verbatim', () => {
    const text = 'erstelle eine Webseite mit Hero-Video für die Tierheim-Kampagne';
    const synth = buildSyntheticFlowCommand(text);
    expect(synth).toBe(`/flow ${text}`);
  });

  it('does not touch internal whitespace / casing', () => {
    const text = '  Bau MIR  eine LandingPage  ';
    // Caller (ChatShell) hat üblicherweise schon getrimmt — die Funktion
    // selbst lässt aber bewusst alles durch.
    const synth = buildSyntheticFlowCommand(text);
    expect(synth).toBe(`/flow ${text}`);
  });
});
