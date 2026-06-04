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

Not yet covered (tracked):

- ◻ **Multi-agent swarm / workstream runs** (`server/agents/tier-orchestrator.ts`,
  `spawnInTmux`, ultracoding, bug-swarm): these spawn the CLI on a separate path
  that is **not yet tokenized**. Use the swarm with care for sensitive data until
  the single CLI-spawn chokepoint lands.
- ◻ **Agent transcript stream** (per-token replay log) is not rehydrated.
- ◻ **Names in re-sent history**: NER runs on the new message; older messages get
  deterministic tokenization only (a known-value sweep is the planned fix).

**Plan:** move tokenization to a single chokepoint at the actual `claude`/`codex`
CLI spawn (covers every path at once) + a known-entity sweep so a name tokenized
once stays tokenized in later turns. Until then, the claims above are scoped to the
covered paths — laz.ing does **not** promise zero PII egress on the swarm path yet.
