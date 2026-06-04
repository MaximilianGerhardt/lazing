# Privacy & AI compliance — first steps (GDPR / EU AI Act)

> **Not legal advice.** This documents the technical measures laz.ing ships and a
> roadmap toward GDPR (DSGVO) and EU AI Act readiness. Whether and how these laws
> apply depends on *your* deployment and use case; consult qualified counsel.

laz.ing is **local-first by design**: state, the database, the RAG index, and the
PII vault live on your machine. The only data that leaves it is what you explicitly
send to an external engine — and even that can be pseudonymized first.

## What ships today (the measures)

| Concern | Measure in laz.ing |
|---|---|
| **Data minimization** (GDPR Art. 5(1)(c)) | Local-first storage; nothing is sent to a third party unless you call an external engine. |
| **Pseudonymization** (GDPR Art. 4(5), Art. 25 — data protection by design) | The **local PII vault**: detected entities are replaced by tokens before any cloud call; real values are AES-256-GCM-encrypted locally and never leave the box. See [docs/privacy.md](privacy.md). |
| **On-device processing** | The optional NER layer detects names with a **small local Ollama model** — so even entity *detection* stays local. |
| **Purpose / scope limitation** | Every record carries a workspace scope (N9); cross-workspace retrieval is gated. The PII vault is workspace-isolated. |
| **Traceability / record-keeping** (GDPR Art. 30; EU AI Act logging) | Event-sourced, append-only audit ledger (`reasoning_audit`, the events log) records decisions, sources, and corrections. |
| **Human oversight** (EU AI Act Art. 14) | The critic loop + operator-override path keep a human in the loop; agents are steerable mid-run. |
| **Engine choice / data residency** | Bring your own engine. With **Ollama only**, no data leaves the machine at all. |

## Where external LLMs fit

When you use Claude Code or Codex, the provider acts as a **processor** for the text
you send. The PII vault reduces what they ever see to opaque tokens. With the vault
on, a provider receives `[[EMAIL_1]]`, not the real address. **Disclose this in your
own privacy notice** if you process third-party personal data.

## EU AI Act — orientation (first steps)

laz.ing is an **AI orchestration tool / general-purpose component**, not a finished
high-risk system. Its risk classification depends on *your* use case. Starting points:

- **Transparency (Art. 50):** users must know they're interacting with AI and when
  content is AI-generated. → *First step shipped:* the onboarding surfaces an AI +
  privacy disclaimer; chat clearly attributes assistant output. *Planned:* a
  per-deployment, configurable transparency banner.
- **Logging & traceability:** high-risk uses require event logging over the lifecycle.
  → *Shipped:* the append-only ledger. *Planned:* exportable, tamper-evident audit
  reports (content-hash chains already exist on trace rows).
- **Human oversight (Art. 14):** → *Shipped:* critic loop + operator override +
  mid-course injection. *Planned:* mandatory-review gates per workflow.
- **Data governance (Art. 10, for high-risk):** → *Shipped:* workspace scope + PII
  vault. *Planned:* dataset provenance records for any fine-tuning/RAG corpus.
- **Risk management & conformity:** → *Planned:* a per-deployment risk-assessment
  template + a conformity checklist; classify the concrete use, document residual
  risk, and (if high-risk) the Art. 9 risk-management cycle.

## Roadmap (these are the first steps)

1. ✅ Local PII vault + pseudonymization for external calls (wired, gated).
2. ✅ On-device NER option (small local model).
3. ✅ Onboarding privacy + AI-use disclaimer.
4. ◻ Configurable transparency banner (Art. 50) per deployment.
5. ◻ Exportable GDPR Art. 30 records + tamper-evident audit export.
6. ◻ Per-use-case risk-assessment + EU AI Act conformity checklist template.
7. ◻ Data-subject request tooling (export / erase by entity, using the vault map).
8. ◻ Configurable data-residency policy (e.g. "Ollama-only / no cloud" enforced).

The vault already gives a natural hook for **erasure**: deleting a workspace's
`pii_vault` rows renders any previously-sent token irreversible — a building block
for Art. 17 (right to be forgotten) tooling.
