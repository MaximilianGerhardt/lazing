# Architecture · Lokale Modelle (Phase LM, geplant)

> Status: **Architektur-Skizze**. Code-Seite ist Stub (`lib/agents/local-model.ts`). Echte Implementation kommt nach OSS-Launch (Phase LM-Implement).

## Warum lokale Modelle in laz.ing?

| Reason | Was sich ändert |
|---|---|
| **Pricing-frei** | Kein Token-Counter, keine MAX-Plan-Caps. Sinnvoll für 24/7-Routinen, Heartbeats, Auto-Dispatch-Stages. |
| **Air-Gap-fähig** | Self-Host komplett ohne externe API-Calls. Compliance-Use-Cases (Defense, Public Sector). |
| **Datenschutz** | DSGVO/HIPAA-Daten verlassen den Server nie. Kein AVV mit Anthropic nötig wenn nur Local-Mode. |
| **Latenz-Kontrolle** | Lokale GPU-Inference gibt vorhersagbare Latenzen ohne Rate-Limit-Spikes. |
| **Hybrid-Modelle** | Schnelle Pre-Filter via Local, finale Synthese via Claude (Cost-Optimization). |

## Welche Modelle eignen sich?

| Modell | Größe | Stärke | Limit |
|---|---|---|---|
| **Gemma 3 7B / 27B** | 7B / 27B | Allround-Plan-Schreiber, gute Instruction-Following | weniger sub-task-Decomposition als Claude |
| **Qwen 2.5 Coder 32B** | 32B | Code-Generation auf Niveau GPT-4o-mini | langsam ohne high-end GPU |
| **DeepSeek-Coder V3** | 236B MoE | Top-Tier-Code, lange Context | braucht 4× A100 oder vergleichbar |
| **Llama 3.3 70B** | 70B | Long-Context-Reasoning | RAM-hungry (>40 GB) |

Empfehlung für laz.ing-Self-Host: **Gemma 3 7B oder 27B als Default**, Qwen 2.5 Coder 32B für Coding-Workstreams (mit ausreichend GPU).

## Architektur — wie integriert sich Local in den Spawn-Pfad?

Heute: alle Spawns laufen über `claude-code` CLI (in tmux-Sessions, siehe `server/agent-server.ts` und `server/agents/tmux-spawn.ts`). Provider ist Anthropic API via `~/.claude/credentials.json` (MAX-Plan oder shared System-Token).

Future (Phase LM-Implement):

```
spawnInTmux(opts) → resolveLocalModel(env.LAZYOS_LOCAL_MODEL)
                       │
                       ├── null → claude-code CLI (heute)
                       │
                       └── LocalModelConfig → switchToLocalProvider()
                                                  │
                                                  ├── ollama:* → POST http://127.0.0.1:11434/api/generate
                                                  ├── lmstudio:* → POST http://127.0.0.1:1234/v1/chat/completions (OpenAI-compat)
                                                  └── vllm:* → POST http://127.0.0.1:8000/v1/chat/completions
```

**Wichtig:** Cross-Roast (Phase RA), Innovation-Button (Phase IN) bleiben Claude-only zum Start — ihre Qualität braucht Frontier-Modelle. Local ist erstmal für Routinen, Heartbeats, Single-Stage-Spawns.

## ENV-Konfiguration

```bash
# .env.local

# Format: <provider>:<model>[@<base-url>]
# Beispiele:
LAZYOS_LOCAL_MODEL=ollama:gemma3:7b
# LAZYOS_LOCAL_MODEL=ollama:gemma3:27b@http://gpu-box.local:11434
# LAZYOS_LOCAL_MODEL=lmstudio:qwen2.5-coder-32b
# LAZYOS_LOCAL_MODEL=vllm:deepseek-coder-v3
```

Wird `LAZYOS_LOCAL_MODEL` nicht gesetzt → claude-code CLI wie heute.

## Auswahl pro Spawn (Future)

```ts
spawnInTmux({
  // ...,
  model: 'opus' | 'sonnet' | 'haiku' | 'local',
  // wenn 'local' → resolveLocalModel() entscheidet welcher
})
```

Routinen + Heartbeats werden default auf `local` schalten. Cross-Roast, Lead-V1, Synthesis bleiben `opus`.

## Wann ist das fertig?

**Keine Garantie.** Wir bauen das wenn:
1. OSS-Launch durch (alle Phase OSS-Tüten erledigt).
2. Ein User ein konkretes Compliance-Use-Case mitbringt.
3. Wir eine GPU-Maschine zum Testen haben.

Bis dahin ist `lib/agents/local-model.ts` Skeleton. Setzen von `LAZYOS_LOCAL_MODEL` heute → wirft `LocalModelNotImplementedError`.

## Links

- `lib/agents/local-model.ts` — Type-Defs + Resolver
- `lib/agents/spawn.ts` — wo der Hook eingebaut wird (Future)
- [Ollama API](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [LM-Studio OpenAI-Compat](https://lmstudio.ai/docs/api/server)
- [vLLM OpenAI-Server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html)
