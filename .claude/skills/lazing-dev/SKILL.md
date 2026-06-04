---
name: lazing-dev
description: laz.ing-Entwickler-Playbook — verbindliche Konventionen für jede Code-Arbeit an laz.ing (Next.js 16 / TypeScript / Drizzle). Nutze IMMER bei Build/Fix/Refactor/Deploy an laz.ing: N1–N11-Constraints, Build-Test-Deploy-Loop (typecheck-Baseline, vitest, geguardeter .next-Swap), Commit/Push-Disziplin, Substrat-Regeln (workstreams erweitern, keine Parallel-Tabellen), engine-übergreifende Skills.
when_to_use: laz.ing bauen, Feature, Slice, Fix, Refactor, Migration, Deploy, Commit, "baue an lazyos/laz.ing", Workstream, Skill.
allowed-tools: Bash(pnpm typecheck), Bash(pnpm exec vitest run *), Read, Grep, Glob
---

# laz.ing Dev-Playbook

Verbindliche Konventionen für JEDE Code-Arbeit an laz.ing. Brand = laz.ing,
Code-Identifier bleiben `lazyos-*` (Legacy-Schema, Rollback via ENV).

## N1–N11 (nicht verhandelbar)
- **N1** Detail-Preservation: VERBATIM, kein `.slice`/`.substring` auf Ledger-/
  Prompt-/Config-Feldern. Werte nie still kürzen.
- **N2** Kein globales RAG-Fallback. Scope-Envelope pro Chunk + pro Query;
  Cross-Scope nur via Bridge + Art.-30-Audit (fail-closed).
- **N6** Deterministische Validatoren VOR symbolischem Reasoning (kein LLM, wo
  eine Heuristik reicht). N7 lexical vor vector.
- **N8** Trace = Evidenz: Entscheidungen/Quellen/Korrekturen append-only.
- **N9** `workspace_id`/ManifestCoord auf jeder persistierten Entität.
- **N10** Tamper-Evidenz via sha256 `content_hash`. Doppelter Hash = Idempotenz.
- **N11** Ressourcen: deepseek-r1:14b NUR für Synthese, ≤2 schwere lokale Jobs.

## Substrat-Disziplin
- workstreams + subdispatches ERWEITERN — KEINE parallelen `swarm_*`-Tabellen.
- Additive Migrationen (`ALTER TABLE ADD COLUMN`); in `db/client.ts` MIGRATIONS
  registrieren. Idempotent (`IF NOT EXISTS`).
- Recovery vor Reinvention: `_pending/`-Files erst Port/Adapt/Drop entscheiden.

## Build → Test → Deploy-Loop
```bash
find . -maxdepth 2 -name "*\ 2.ts" -delete        # macOS-Dup-Files killen
pnpm typecheck 2>&1 | grep -cE 'error TS'          # MUSS == Baseline (aktuell 22)
NODE_OPTIONS=--experimental-require-module pnpm exec vitest run <pfad>   # Tests grün
# Deploy:
LAZYOS_DIST_DIR=.next.predeploy pnpm exec next build
# GEGUARDETER Swap (Lehre: nacktes `mv .next .next.bak && …` killt :4200 wenn .next fehlt):
[ -d .next.bak ] && mv .next.bak .next.bak.prev; [ -d .next ] && mv .next .next.bak; mv .next.predeploy .next
pkill -f "next start -p 4200"; nohup pnpm exec next start -p 4200 &     # :4200 Prod
pkill -f agent-server.ts; set -a; source .env.local; set +a; nohup ./node_modules/.bin/tsx server/agent-server.ts &  # :4201
pnpm verify:deploy                                  # MUSS GRÜN
```
Rollback via `.next.bak`. Engine-Änderungen (server/*) brauchen :4201-Restart;
Client/Route brauchen :4200-Rebuild.

## Commit / Push / Git
- **Commit nur wenn der User es sagt** (oder im autonomen Auftrag). **Push NUR
  auf explizite Ansage.** Nicht auf `main` direkt — Feature-Branch.
- Commit-Message endet mit:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Pro Slice ein fokussierter Commit (Schema → Service → Route → UI → Test).

## Surfaces / Chat
- Neue `<surface:KIND>` = `lib/chat/surface-parser.ts` SURFACE_KINDS +
  `lib/surfaces/registry.ts` (Record erzwingt Vollständigkeit) + Renderer in
  `SurfaceRenderer.tsx` (exhaustive switch).
- Design-Manifest: Pitch-Black `#070707`, SF Pro, Tokens NUR in `app/globals.css`
  `:root`. Keine Roh-Hex in tsx, keine Emojis in UI.

## Engine-übergreifende Skills
- Store `~/.lazyos/skills`; `lazyos-cli skill install <pfad|owner/repo[/sub]>`
  synct in claude+codex (nativ) + ollama (Prompt). `skill validate|bench`.

## Owner-Arbeitsweise
- Volldetail statt Abstraktion (N1 gilt auch im Gespräch). Bilingual DE/EN.
- Auto-Mode: sofort ausführen mit dokumentierten, reversiblen Annahmen;
  destruktive/outward-facing Aktionen bestätigen. Niemals Fast-Mode faken.
