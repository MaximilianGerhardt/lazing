/**
 * Ticket API — Zod-Schemas (shared zwischen Frontend & Backend).
 *
 * Regeln:
 *  - Alle API-Bodies werden gegen diese Schemas validiert.
 *  - Frontend-Formulare nutzen dieselben Schemas via react-hook-form
 *    (nicht in diesem Modul — aber direkt importierbar).
 *  - Keine Abhaengigkeit auf DB oder Event-Log hier — reine Typen.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive Schemas
// ---------------------------------------------------------------------------

/**
 * Workspace-ID. Dynamische Discovery (Sprint 2 · 7C). Wir akzeptieren
 * slug-style IDs (`lazyos`, `demo-client`, `tap`, `private`) UND Legacy-
 * Segment-IDs (`@north`, `@clientb`, `@own`, `@private`, `@system`) —
 * der Service migriert letztere bei Bedarf.
 */
export const WorkspaceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(@[a-z]+|[a-z0-9][a-z0-9-]*)$/i, "invalid workspace id");

export const TicketStatusSchema = z.enum(["open", "done", "danger", "wait"]);

export const TicketPrioSchema = z
  .string()
  .min(1)
  .max(8)
  .regex(/^P[0-3]([.-].*)?$/i, "prio must look like P0, P1, P2, P3");

export const ActorSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (v) => v === "system" || v.startsWith("user:") || v.startsWith("agent:"),
    { message: "actor must be 'system', 'user:*' or 'agent:*'" },
  );

/** Tag-Liste: deduped, max 32 items, je max 40 chars. */
export const TagListSchema = z
  .array(z.string().min(1).max(40))
  .max(32)
  .transform((tags) => Array.from(new Set(tags)));

// ---------------------------------------------------------------------------
// Create / Update / List
// ---------------------------------------------------------------------------

export const CreateTicketBodySchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    title: z.string().min(1, "title required").max(200),
    body: z.string().max(20_000).optional(),
    prio: TicketPrioSchema.optional(),
    due: z.string().max(40).optional(),
    tags: TagListSchema.optional(),
    assignee: z.string().min(1).max(80).optional(),
    status: TicketStatusSchema.optional(),
    workflowState: z.string().min(1).max(40).optional(),
    actor: ActorSchema.optional(),
    /** Claude-Code-Session-UUID, die dieses Ticket erstellt (Handoff-Punkt 5). */
    sessionId: z.string().min(1).max(64).optional(),
    /** Workstream-Container für Multi-Agent-Plan (Phase W). */
    workstreamId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^WS-[A-Za-z0-9]+$/i)
      .optional(),
    /** Parent-Ticket für hierarchische Pläne (Phase H). */
    parentTicketId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^TCK-[A-Za-z0-9]+$/i)
      .optional(),
  })
  .strict();

export type CreateTicketBody = z.infer<typeof CreateTicketBodySchema>;

export const UpdateTicketBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(20_000).optional(),
    prio: TicketPrioSchema.optional(),
    due: z.string().max(40).optional(),
    tags: TagListSchema.optional(),
    assignee: z.string().min(1).max(80).optional(),
    status: TicketStatusSchema.optional(),
    workflowState: z.string().min(1).max(40).optional(),
    actor: ActorSchema.optional(),
    /** Claude-Code-Session-UUID die dieses Update initiiert (Handoff-Punkt 5). */
    sessionId: z.string().min(1).max(64).optional(),
    /** Workstream-Container für Multi-Agent-Plan (Phase W). */
    workstreamId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^WS-[A-Za-z0-9]+$/i)
      .optional(),
    /** Parent-Ticket für hierarchische Pläne (Phase H). */
    parentTicketId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^TCK-[A-Za-z0-9]+$/i)
      .optional(),
  })
  .strict()
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: "at least one field required" },
  );

export type UpdateTicketBody = z.infer<typeof UpdateTicketBodySchema>;

export const ListTicketsQuerySchema = z
  .object({
    workspaceId: WorkspaceIdSchema.optional(),
    status: z.union([TicketStatusSchema, z.literal("all")]).optional(),
    query: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

export type ListTicketsQuery = z.infer<typeof ListTicketsQuerySchema>;

export const CommentBodySchema = z
  .object({
    text: z.string().min(1, "text required").max(4000),
    actor: ActorSchema.optional(),
  })
  .strict();

export type CommentBody = z.infer<typeof CommentBodySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses URL search params into a typed ListTicketsQuery. Returns a
 * discriminated union, so callers can render validation errors cleanly.
 */
export function parseListTicketsQuery(
  input: URLSearchParams | Record<string, unknown>,
):
  | { ok: true; value: ListTicketsQuery }
  | { ok: false; issues: z.ZodIssue[] } {
  const raw =
    input instanceof URLSearchParams ? Object.fromEntries(input) : input;
  const parsed = ListTicketsQuerySchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: parsed.error.issues };
}
