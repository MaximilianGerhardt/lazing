# Local PII vault (privacy / GDPR)

laz.ing can keep personal data out of the hands of external LLM providers. When
enabled, anything sent to a **cloud engine** (Claude Code / Codex) first passes
through a **local PII vault**: detected entities are replaced by opaque
placeholder tokens, and the real values are encrypted and stored **only on your
machine**. The cloud model sees `[[EMAIL_1]]`, never `alice@example.com`.

## How it works

```
your text ──► tokenize ──►  "[[EMAIL_1]] owes [[IBAN_1]]"  ──► external LLM (cloud)
                 │                                                    │
        AES-256-GCM, local                                     reply with tokens
        pii_vault table                                              │
                 ▼                                                    ▼
        real values stay local ◄──────────── rehydrate ◄──── reply shown to you
```

- **Detection floor is deterministic (N6):** pure regex for structured
  identifiers — email, IBAN, card (Luhn-checked), phone, IPv4
  (`lib/privacy/pii-detectors.ts`). No model needed, no false sense of security.
- **Optional local-LLM layer (N11):** a *small, local* Ollama model can additionally
  flag names (PERSON / ORG / LOCATION) that a regex can't — so even entity
  *detection* never leaves the box (`lib/privacy/pii-ner-ollama.ts`). Off by default.
- **Encryption + storage:** real values are AES-256-GCM-encrypted with
  `LAZYOS_CREDENTIAL_KEY` and stored in the local `pii_vault` table, **scoped per
  workspace** (N9). A token minted in one workspace cannot be de-tokenized in
  another — cross-workspace reveal is impossible by construction.
- **Stable + deduplicated:** the same value always maps to the same token within a
  workspace, so the model still sees consistent references.

## Enabling it

```bash
LAZYOS_PII_VAULT=true          # turn the vault on (off = pure pass-through)
LAZYOS_PII_NER=true            # optional: also detect names via a local model
LAZYOS_PII_NER_MODEL=qwen2     # small Ollama model for the NER layer
# LAZYOS_CREDENTIAL_KEY must be set (64 hex chars) — it already is for the app.
```

## Using it in code (the seam)

Wrap any call to a cloud engine; local engines (Ollama) need no protection since
they never leave the machine:

```ts
import { protectForExternalAsync, rehydrate } from "@/lib/privacy/protect";

const { safe } = await protectForExternalAsync(workspaceId, prompt);
const reply = await cloudEngine.chat(safe);   // cloud sees only [[TYPE_n]] tokens
const shown = rehydrate(workspaceId, reply);  // real values restored locally
```

`protectForExternal` (sync, deterministic-only) and `protectForExternalAsync`
(adds the optional local NER) both return `{ safe, entityCount }`. Both are pure
pass-throughs when `LAZYOS_PII_VAULT` is off.

## Scope & limits (honest)

- It is **wired into the chat stream route** (`app/api/chat/stream`): outgoing
  prompts are tokenized before they reach the cloud engine(s) (parallel-all,
  Codex, and the agent-server Claude path), and responses are detokenized locally
  — including a **buffered SSE transform** for the streamed agent path so a token
  split across chunks is reassembled before the user sees it. All of this is gated
  by `LAZYOS_PII_VAULT`: when off, the path is a byte-identical pass-through.
- Regex detection is conservative (it favors precision over recall to avoid
  mangling text). The local-NER layer raises recall for names but is best-effort
  and model-dependent.
- The vault protects values *in transit to and at rest from* external models. It
  is not a substitute for workspace sensitivity rules or the RAG scope envelope —
  it complements them.

## Coverage & known gaps (honest, in progress)

The vault is wired into the **default chat paths**, verified by review:

- ✅ Orchestrate path (parallel-all / Codex / Ollama): prompt tokenized, reply +
  persistence rehydrated.
- ✅ Agent (Claude) path: the user prompt, the **RAG context**, and the
  **system prompt** (which embeds subchat customer comms + notes) are tokenized
  before the cloud; the live stream and the persisted history/ledger/event-log are
  rehydrated to real values.
- ✅ Structured PII (email/IBAN/card/phone/IP) everywhere; **names** on the new
  user message when the NER option is on.

- ✅ **Multi-agent swarm / workstream runs** (tier-orchestrator, bug-swarm,
  auto-dispatch): flow through `spawnInTmux`, which tokenizes the system + user
  prompt at that single CLI-spawn chokepoint and rehydrates the result.
- ✅ **Ultracoding orchestrator**: in addition to its `spawnInTmux` spawns it makes
  two *direct* cloud calls that do **not** pass through that chokepoint — task
  synthesis and the diff-review pass — so each is tokenized at its own call site
  (`server/agents/ultracoding-orchestrator.ts`). A review caught these bypassing the
  chokepoint; they are now covered explicitly rather than by assumption.
- ✅ **Names across turns**: a known-value sweep re-tokenizes a name in later
  turns once any turn's NER has stored it (no repeated model calls).
- ✅ **Secondary LLM features that call the cloud engine directly** — background
  plan-dispatch on the default chat path, `/api/innovate`, `/api/lanes/compile`,
  `/api/flow/compose-and-run`, the plan-executor text-only step branch,
  `/api/agents/spawn`, and image generation (`/api/imagegen`). A fourth review
  found these all shared one root cause: `pickEngine(selection, ['codex-cli'])`
  still resolves to **claude-cli (cloud)**, and each caller sent a raw prompt. The
  fix is one boundary wrapper, `protectEngine(workspaceId, engine)`
  (`lib/privacy/protect.ts`), applied at every cloud-egress site: it tokenizes the
  outbound messages and rehydrates the reply, and is a pass-through for local
  Ollama or when the vault is off.
- ✅ **Regression guard (N6):** a deterministic source test
  (`lib/privacy/__tests__/egress-guard.test.ts`) fails the build if a new file
  uses the codex-excluded `pickEngine` pattern, or calls the cloud engine
  directly, without routing through `protectEngine` — so this leak class cannot
  silently return.

Still tracked:

- ◻ **Agent transcript stream** (the per-token replay log) is not yet rehydrated —
  it is an internal debug/replay artifact, lower visibility than chat history.
- ◻ **Recall**: deterministic detection is conservative; without NER, names are
  only caught after a first NER pass. Detector coverage (more identifier types,
  bare-format phones) is an ongoing improvement.

The protection is now wired at the cloud boundary on every chat + swarm path,
gated by `LAZYOS_PII_VAULT`. Recall (which entities are detected) remains a
best-effort, improving surface — enable the local NER layer for names.
