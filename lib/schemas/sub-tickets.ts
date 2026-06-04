/**
 * Sub-Ticket-Schema (Phase H · 2026-04-27)
 * ----------------------------------------------------------------------
 * Strukturierter Output-Vertrag für den Lead-Synthesizer.
 *
 * Ersetzt das alte YAML-Freitext-Parsing (`parseSubTicketsBlock` in
 * `tier-orchestrator.ts`): YAML aus LLM-Output ist fragil — fehlende
 * Linebreaks, Quoting-Edge-Cases in Titles, halluzinierte Extra-Keys
 * brechen den gesamten Spawn-Pfad. Ab Phase H ist die JSON-Form
 * Source-of-Truth, der Markdown-`## Sub-Tickets`-Block wird **aus** dem
 * JSON gerendert (nicht umgekehrt parst).
 *
 * Tool-Call-Schema-konform: Zod-Schema lässt sich direkt zu JSON-Schema
 * konvertieren (`zod-to-json-schema`) und in der Anthropic-Tool-Definition
 * als `input_schema` setzen. Die `.strict()`-Modus auf den Items verhindert,
 * dass das Modell Extra-Keys erfindet, die wir später still droppen würden.
 *
 * Limits (konsolidierter Plan, Open-Question 3):
 *   - Hard-Cap 12 Items (P2/P3 werden bei >12 verworfen, nicht der ganze
 *     Run; siehe `MAX_SUB_TICKETS`).
 *   - Title 3-120 chars (kein leerer/Riesen-String).
 *   - Body bis 4000 chars (genug für 2-4 Sätze + Akzeptanzkriterium).
 *   - Prio strikt P0|P1|P2|P3 (kein P4, kein "high", kein Freetext).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Konstanten — single source of truth, importable für Worker + UI
// ---------------------------------------------------------------------------

/** Hard-Cap für Sub-Tickets pro Synthesis-Run. Über-Plan: P2/P3 droppen. */
export const MAX_SUB_TICKETS = 12;

export const SUB_TICKET_TITLE_MIN = 3;
export const SUB_TICKET_TITLE_MAX = 120;
export const SUB_TICKET_BODY_MAX = 4000;

/** Prio-Reihenfolge für Truncation: P0 zuerst behalten, P3 zuerst werfen. */
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
 * Einzelnes Sub-Ticket. `.strict()` verhindert Halluzinations-Keys.
 *
 * Felder bewusst flach: title/prio/body, nichts sonst. `tags`,
 * `assignee`, `due` werden NICHT vom Synthesizer befüllt — die erbt
 * der Worker vom Parent-Ticket bzw. setzt sie als `auto-generated`.
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
 * Wrapper-Schema für den Tool-Call-Output. Das Modell ruft das Tool
 * `emit_sub_tickets` mit `{ items: [...] }`. Der äußere Wrapper macht
 * den Tool-Call-Vertrag stabil, falls wir später Top-Level-Felder
 * wie `summary` oder `consensusLevel` hinzufügen wollen.
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
 * Schema für die `payload.subTickets`-Liste auf dem **Outbox-Event**
 * `sub-tickets-planned`. Identisch zu SubTicketItem, separat exportiert
 * damit der Worker nicht das LLM-Tool-Call-Schema importiert.
 */
export const PlannedSubTicketSchema = SubTicketItemSchema;
export type PlannedSubTicket = SubTicketItem;

/**
 * Vollständiges Outbox-Event-Payload für `sub-tickets-planned`.
 * Wird vom Tier-Orchestrator emittiert, vom Sub-Ticket-Spawner-Worker
 * konsumiert. `synthesisHash` = sha256 der Synthesis-Roh-Outputs +
 * Master-ID, dient als Idempotenz-Anker für Crash-Resume.
 */
export const SubTicketsPlannedPayloadSchema = z
  .object({
    masterId: z.string().regex(/^TCK-[A-Za-z0-9]+$/i, "invalid masterId"),
    workspaceId: z.string().min(1).max(64),
    workstreamId: z.string().regex(/^WS-[A-Za-z0-9]+$/i).optional(),
    synthesisHash: z.string().regex(/^[a-f0-9]{64}$/, "expect sha256 hex"),
    promptVersion: z.string().min(1).max(40),
    items: z.array(PlannedSubTicketSchema).min(1).max(MAX_SUB_TICKETS),
    /** Trace-ID-Verkettung (Cross-Cutting Sub-Ticket im Plan). */
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
 * Wendet den 12-Item-Hard-Cap an. P0/P1 werden zuerst behalten,
 * P2/P3-Überschuss wird verworfen. Behält die Original-Reihenfolge
 * innerhalb gleicher Prio (stabil).
 *
 * Gibt das ggf. gekürzte Array + Liste der gedroppten Titles zurück
 * (für Logging/Audit-Trail).
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
 * JSON-Schema-Repräsentation des Tool-Call-Inputs für die Anthropic-API.
 * Keine externe Dependency — wir schreiben die JSON-Schema-Form von Hand,
 * weil das Schema klein ist und `zod-to-json-schema` einen 200kb-Tail
 * an die Server-Bundle hängt. Wenn das Schema oben angepasst wird,
 * MUSS dieser Block hier mitgepflegt werden — entsprechende Test in
 * `lib/schemas/sub-tickets.spec.ts` (Phase H+I T-Plan) prüft Schema
 * vs. JSON-Schema-Form auf Drift.
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
 * Tool-Definition fürs LLM (Anthropic-Format). Kann direkt in den
 * `tools`-Array bei `messages.create` gegeben werden. Der Server liest
 * dann `tool_use.input` und gibt es in `SubTicketsOutputSchema.parse()`.
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
 * Safe-parse + Cap. Konvenienz-Funktion für den Tier-Orchestrator:
 * nimmt den rohen `tool_use.input`, validiert, kürzt auf 12. Bei
 * Schema-Drift returned `{ ok: false, issues }` — der Caller entscheidet
 * dann ob `synthesis-malformed` emittiert wird.
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
