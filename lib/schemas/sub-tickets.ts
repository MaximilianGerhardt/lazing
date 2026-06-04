/**
 * Sub-ticket schema (Phase H · 2026-04-27)
 * ----------------------------------------------------------------------
 * Structured output contract for the lead synthesizer.
 *
 * Replaces the old YAML free-text parsing (`parseSubTicketsBlock` in
 * `tier-orchestrator.ts`): YAML from LLM output is fragile — missing
 * line breaks, quoting edge cases in titles, hallucinated extra keys
 * break the entire spawn path. From Phase H on, the JSON form is the
 * source of truth; the markdown `## Sub-Tickets` block is rendered **from** the
 * JSON (not parsed the other way around).
 *
 * Tool-call-schema-compliant: the Zod schema can be converted directly to JSON-Schema
 * (`zod-to-json-schema`) and set as `input_schema` in the Anthropic tool definition.
 * The `.strict()` mode on the items prevents
 * the model from inventing extra keys that we would later drop silently.
 *
 * Limits (consolidated plan, open-question 3):
 *   - Hard cap 12 items (P2/P3 are dropped at >12, not the whole
 *     run; see `MAX_SUB_TICKETS`).
 *   - Title 3-120 chars (no empty/giant string).
 *   - Body up to 4000 chars (enough for 2-4 sentences + acceptance criterion).
 *   - Prio strictly P0|P1|P2|P3 (no P4, no "high", no free text).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants — single source of truth, importable for worker + UI
// ---------------------------------------------------------------------------

/** Hard cap for sub-tickets per synthesis run. Over-plan: drop P2/P3. */
export const MAX_SUB_TICKETS = 12;

export const SUB_TICKET_TITLE_MIN = 3;
export const SUB_TICKET_TITLE_MAX = 120;
export const SUB_TICKET_BODY_MAX = 4000;

/** Prio order for truncation: keep P0 first, drop P3 first. */
const PRIO_ORDER: Record<SubTicketPrio, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const SubTicketPrioSchema = z.enum(["P0", "P1", "P2", "P3"]);
export type SubTicketPrio = z.infer<typeof SubTicketPrioSchema>;

/**
 * A single sub-ticket. `.strict()` prevents hallucination keys.
 *
 * Fields deliberately flat: title/prio/body, nothing else. `tags`,
 * `assignee`, `due` are NOT populated by the synthesizer — the
 * worker inherits them from the parent ticket or sets them as `auto-generated`.
 */
export const SubTicketItemSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(SUB_TICKET_TITLE_MIN, "title too short")
      .max(SUB_TICKET_TITLE_MAX, "title too long"),
    prio: SubTicketPrioSchema,
    body: z
      .string()
      .max(SUB_TICKET_BODY_MAX, "body too long")
      .default(""),
  })
  .strict();
export type SubTicketItem = z.infer<typeof SubTicketItemSchema>;

/**
 * Wrapper schema for the tool-call output. The model calls the tool
 * `emit_sub_tickets` with `{ items: [...] }`. The outer wrapper makes
 * the tool-call contract stable in case we later want to add top-level fields
 * like `summary` or `consensusLevel`.
 */
export const SubTicketsOutputSchema = z
  .object({
    items: z
      .array(SubTicketItemSchema)
      .min(1, "need at least one sub-ticket")
      .max(50, "absurd item count, drop and ask for retry"),
  })
  .strict();
export type SubTicketsOutput = z.infer<typeof SubTicketsOutputSchema>;

/**
 * Schema for the `payload.subTickets` list on the **outbox event**
 * `sub-tickets-planned`. Identical to SubTicketItem, exported separately
 * so the worker does not import the LLM tool-call schema.
 */
export const PlannedSubTicketSchema = SubTicketItemSchema;
export type PlannedSubTicket = SubTicketItem;

/**
 * Full outbox-event payload for `sub-tickets-planned`.
 * Emitted by the tier orchestrator, consumed by the sub-ticket-spawner
 * worker. `synthesisHash` = sha256 of the raw synthesis outputs +
 * master ID, serves as the idempotency anchor for crash-resume.
 */
export const SubTicketsPlannedPayloadSchema = z
  .object({
    masterId: z.string().regex(/^TCK-[A-Za-z0-9]+$/i, "invalid masterId"),
    workspaceId: z.string().min(1).max(64),
    workstreamId: z.string().regex(/^WS-[A-Za-z0-9]+$/i).optional(),
    synthesisHash: z.string().regex(/^[a-f0-9]{64}$/, "expect sha256 hex"),
    promptVersion: z.string().min(1).max(40),
    items: z.array(PlannedSubTicketSchema).min(1).max(MAX_SUB_TICKETS),
    /** Trace-ID chaining (cross-cutting sub-ticket in the plan). */
    traceId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type SubTicketsPlannedPayload = z.infer<
  typeof SubTicketsPlannedPayloadSchema
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Applies the 12-item hard cap. P0/P1 are kept first,
 * the P2/P3 surplus is dropped. Preserves the original order
 * within the same prio (stable).
 *
 * Returns the possibly-shortened array + a list of the dropped titles
 * (for logging/audit trail).
 */
export function capSubTickets(items: SubTicketItem[]): {
  kept: SubTicketItem[];
  dropped: SubTicketItem[];
} {
  if (items.length <= MAX_SUB_TICKETS) {
    return { kept: items, dropped: [] };
  }

  // Stable sort: append original index to break ties, then sort by
  // (prio, idx) and slice.
  const indexed = items.map((it, idx) => ({ it, idx }));
  indexed.sort((a, b) => {
    const pa = PRIO_ORDER[a.it.prio];
    const pb = PRIO_ORDER[b.it.prio];
    if (pa !== pb) return pa - pb;
    return a.idx - b.idx;
  });
  const kept = indexed.slice(0, MAX_SUB_TICKETS).map((x) => x.it);
  const dropped = indexed.slice(MAX_SUB_TICKETS).map((x) => x.it);
  return { kept, dropped };
}

/**
 * JSON-Schema representation of the tool-call input for the Anthropic API.
 * No external dependency — we write the JSON-Schema form by hand,
 * because the schema is small and `zod-to-json-schema` appends a 200kb tail
 * to the server bundle. When the schema above is adjusted,
 * this block here MUST be maintained too — the corresponding test in
 * `lib/schemas/sub-tickets.spec.ts` (Phase H+I T-plan) checks the schema
 * vs. the JSON-Schema form for drift.
 */
export const SUB_TICKETS_TOOL_JSON_SCHEMA = {
  type: "object",
  required: ["items"],
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        required: ["title", "prio"],
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            minLength: SUB_TICKET_TITLE_MIN,
            maxLength: SUB_TICKET_TITLE_MAX,
          },
          prio: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          body: {
            type: "string",
            maxLength: SUB_TICKET_BODY_MAX,
            default: "",
          },
        },
      },
    },
  },
} as const;

/**
 * Tool definition for the LLM (Anthropic format). Can be passed directly into the
 * `tools` array at `messages.create`. The server then reads
 * `tool_use.input` and feeds it into `SubTicketsOutputSchema.parse()`.
 */
export const SUB_TICKETS_TOOL_DEFINITION = {
  name: "emit_sub_tickets",
  description:
    "Emit the final list of sub-tickets distilled from the multi-agent synthesis. " +
    "Each sub-ticket must be self-contained, executable in one work session, with a " +
    "clear acceptance criterion in the body. Use P0 for blockers, P1 for primary work, " +
    "P2 for nice-to-haves, P3 for follow-ups. Hard limit: 12 items — keep the most " +
    "load-bearing ones, drop the rest. Do NOT include any other top-level keys.",
  input_schema: SUB_TICKETS_TOOL_JSON_SCHEMA,
} as const;

/**
 * Safe-parse + cap. Convenience function for the tier orchestrator:
 * takes the raw `tool_use.input`, validates, truncates to 12. On
 * schema drift it returns `{ ok: false, issues }` — the caller then decides
 * whether `synthesis-malformed` is emitted.
 */
export function parseAndCapSubTickets(
  raw: unknown,
):
  | { ok: true; items: SubTicketItem[]; dropped: SubTicketItem[] }
  | { ok: false; issues: z.ZodIssue[] } {
  const parsed = SubTicketsOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues };
  }
  const { kept, dropped } = capSubTickets(parsed.data.items);
  return { ok: true, items: kept, dropped };
}
