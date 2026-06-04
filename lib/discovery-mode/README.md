# lib/discovery-mode — 10 Discovery-Modi + Continuity-Check

2026-05-29 · Opus 4.8 · Quelle: Innovation/Expertise-Compiler Master-Brief §6 + §20.

Additive dritte Klassifikations-Achse. Ersetzt **kein** bestehendes Modul:

| Modul | Achse | Werte |
| --- | --- | --- |
| `lib/workstreams/intent-classifier.ts` | WAS-FÜR-EINE-ARBEIT (Alt-Modell) | idea · implementation · bug-fix · question · discussion |
| `lib/chat/intent-flow-classifier.ts` | IST-ES-EIN-FLOW | flow · unknown |
| **`lib/discovery-mode/detect.ts`** | **IN-WELCHEM-DISCOVERY-MODUS** | brainstorm · clarify · extract_expertise · role_reverse_engineer · simulate · innovate · plan_graph · build · review · reconcile |

## Kernregel (§20.1, verbatim)

> „Nicht jede Nachricht ist ein Planungsauftrag."

Deshalb ist der Fail-soft-Default **`clarify`** (nie `build`), und der Tie-Break
bevorzugt erkundende Modi über ausführende. `detectDiscoveryMode` ist
deterministisch (N6), pure, ohne I/O, DE+EN, politeness-tolerant.

## Einhäng-Vorschlag (Haupt-Agent, Chat-Dispatch)

Der Haupt-Agent ruft `detectDiscoveryMode` **vor** `proposePlan`/`composeAndRun`,
analog zur Position des Flow-Classifiers in der `ChatShell`. Pseudocode:

```ts
import {
  detectDiscoveryMode,
  shouldBlockDirectPlan,
  getDiscoveryModeMeta,
} from '@/lib/discovery-mode/detect';
import { continuityCheck } from '@/lib/discovery-mode/continuity';
import { writeDecision } from '@/lib/workstreams/trace-repo';

// 1. Modus erkennen (deterministisch, vor jeder Planung).
const { mode, confidence, signals } = detectDiscoveryMode(userInput);

// 2. §20.1-Gate: bei brainstorm | clarify | extract_expertise | innovate
//    NICHT direkt planen — stattdessen Klär-/Sammel-Surface rendern.
if (shouldBlockDirectPlan(mode)) {
  // KEIN proposePlan. Stattdessen: erkannte Themen, offene Begriffe,
  // vermutete Rollen, Wissenslücken, nächster sinnvoller Modus (§21.1).
  return renderDiscoverySurface({ mode, meta: getDiscoveryModeMeta(mode), signals });
}

// 3. Mode-Wechsel? Continuity-Check fahren (§6 / §20.3).
if (priorMode && priorMode !== mode) {
  const checkpoint = continuityCheck({
    priorMode,
    nextMode: mode,
    priorBeliefs,     // aus ReasoningBank
    priorDecisions,   // aus workstream_decisions
  });

  // §20.3 Frage 5: darf überhaupt geplant werden?
  if (!checkpoint.mayPlan) {
    return renderDiscoverySurface({ mode, checkpoint, signals });
  }

  // Checkpoint als Evidenz/Decision festhalten (N8) — KEINE neue Tabelle.
  // Wir nutzen das bestehende Trace-Substrat workstream_decisions via
  // writeDecision. decisionKind='route' ist der semantisch nächste Wert
  // (Mode-Routing-Entscheidung); rationale = checkpoint.summary (verbatim, N1).
  writeDecision({
    workspaceId,
    workstreamId,
    decisionKind: 'route',
    rationale: checkpoint.summary,
    actor: 'agent',
  });
}

// 4. Nur ab plan_graph | build | review | reconcile (mit mayPlan) → proposePlan.
const plan = await proposePlan(userInput, { discoveryMode: mode });
```

### Persistenz-Entscheidung (N4, kein Schema-Eingriff)

Continuity-Checkpoints werden **nicht** in einer neuen Tabelle abgelegt.
Sie nutzen das bestehende Trace-Substrat `workstream_decisions` über
`writeDecision()` (`lib/workstreams/trace-repo.ts`). Der nächstliegende
`DecisionKind` ist `'route'` (Routing-/Mode-Entscheidung). `continuityCheck`
selbst bleibt **pure** — die Persistenz ist Sache des Aufrufers, damit das
Modul ohne DB unit-testbar bleibt.

> Optionaler Folge-Slice (owner-gated, NICHT hier): einen dedizierten
> `DecisionKind` wie `'mode_switch'` zum CHECK-Enum in `trace-repo.ts` +
> Migration hinzufügen. Solange das nicht passiert, ist `'route'` die korrekte,
> nicht-schema-brechende Wahl.

## Tests

`lib/discovery-mode/__tests__/detect.test.ts` und `continuity.test.ts`
(vitest). Abgedeckt: je Modus ein klares Beispiel, Mehrdeutigkeit → `clarify`,
Brainstorm ≠ `build` (§20.1), Continuity stillValid/superseded/missing/mayPlan.
