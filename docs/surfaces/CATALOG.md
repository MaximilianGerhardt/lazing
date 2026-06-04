# Surface Library — Katalog

> Flow Studio P4 · 2026-05-27. Quelle der Wahrheit: `lib/surfaces/registry.ts`
> (`SURFACE_LIBRARY`). Die Kind-Liste stammt aus `lib/chat/surface-parser.ts`
> (`SURFACE_KINDS`). Dieser Katalog ist eine knappe, handgepflegte Spiegelung
> des Registrys — bei Aenderungen am Registry hier nachziehen. Die
> Vollstaendigkeit wird compile-time (`Record<SurfaceKind, SurfaceMeta>`) und
> runtime (`lib/surfaces/__tests__/registry.test.ts`) erzwungen.

Die Surface Library ist eine **rein additive Metadaten-Schicht**. Sie aendert
**nichts** am Rendering (`SurfaceRenderer.tsx`), am Parser
(`surface-parser.ts`) oder an einer `*Card.tsx`. Sie beschreibt nur, *was* eine
Surface fachlich ist.

## Kategorien

| Kategorie  | Bedeutung                                                                 |
|------------|---------------------------------------------------------------------------|
| `progress` | Laufende, mehrstufige Vorgaenge mit Fortschritt (Pipelines, Loops, Swarms) |
| `prompt`   | Fordert eine Entscheidung/Eingabe vom User                                |
| `tool`     | Tool-/Connector-Aufruf-Vorschau & -Kopplung                               |
| `media`    | Eingebettete Medien — reserviert fuer P5 (imagegen2/Higgsfield/Heygen)    |
| `status`   | Zustands-/Ereignis-Anzeige ohne User-Aktion                               |
| `flow`     | Flow-/Plan-Topologie                                                       |
| `data`     | Daten-/Datei-Artefakte                                                     |

## Verteilung (47 Kinds)

| Kategorie  | Anzahl |
|------------|--------|
| `progress` | 18     |
| `prompt`   | 11     |
| `status`   | 7      |
| `data`     | 6      |
| `flow`     | 3      |
| `tool`     | 2      |
| `media`    | 0 (reserviert P5) |
| **Summe**  | **47** |

## Secret-Invariante

Surfaces, die eine Credential-Interaktion anstossen, tragen das Flag
`emitsSecret: false`. Das ist eine *verifizierbare Aussage*, kein Schalter: der
Typ laesst nur `false` zu. Secrets verlassen **nie** den Out-of-Chat-Pfad
(`credential-request`, `credential-prompt`, `connector-call-preview`,
`onboarding-progress`, `permission-setup`).

## Surfaces nach Kategorie

### progress (18)
`pipeline` · `agent` · `swarm` · `live-swarm` · `workflow-pipeline` ·
`consensus-action` · `live-pipeline` · `iterate-pipeline` · `rate-limit-retry` ·
`bug-fix-swarm` · `bug-fix-pipeline` · `loop-phase` · `iterate-roast` ·
`iterate-version` · `workflow` · `agent-step` · `subagent-fleet` ·
`onboarding-progress`

Hinweis: `workflow` ist die kanonische Pipeline-Surface; `pipeline`,
`live-pipeline`, `workflow-pipeline`, `iterate-pipeline` sind deprecated-Aliasse.
`agent-step` ist die kanonische Tool/Step-Surface (mode-Diskriminator).

### prompt (11)
`decision` · `quickchoice` · `approval` · `tier-choice` · `credential-prompt` ·
`form` · `open-questions` · `plan-open-questions` · `prompt` ·
`credential-request` · `permission-setup`

Hinweis: `prompt` ist die kanonische Prompt-Surface (variant-Diskriminator);
`form`, `open-questions`, `plan-open-questions`, `credential-prompt`,
`quickchoice`, `decision` sind die abgeloesten Family-Mitglieder.

### status (7)
`toast` · `heartbeat` · `workspace` · `routine` · `milestone` · `preview` ·
`user-correction`

### data (6)
`chart` · `ticket` · `invoice` · `document` · `folder` · `cloud-browser`

### flow (3)
`flow-graph` · `subplan` · `sub-workstreams`

### tool (2)
`terminal` · `connector-call-preview`

### media (0)
Reserviert fuer Flow Studio P5 (imagegen2 / Higgsfield / Heygen-Ausgaben).

## API

```ts
import {
  SURFACE_LIBRARY,        // Record<SurfaceKind, SurfaceMeta>
  getSurfaceMeta,         // (kind: string) => SurfaceMeta | null
  listSurfacesByCategory, // (cat) => SurfaceMeta[]
  listAllSurfaces,        // () => SurfaceMeta[]  (kanonische Reihenfolge)
  SURFACE_CATEGORIES,     // readonly SurfaceCategory[]
} from '@/lib/surfaces/registry';
```
