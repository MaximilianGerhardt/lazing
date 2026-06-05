/**
 * Ticket API — Zod schemas (shared between frontend & backend).
 *
 * Rules:
 *  - All API bodies are validated against these schemas.
 *  - Frontend forms use the same schemas via react-hook-form
 *    (not in this module — but directly importable).
 *  - No dependency on DB or event log here — pure types.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------------

/**
 * Workspace ID. Dynamic discovery (Sprint 2 · 7C). We accept
 * slug-style IDs (`lazyos`, `demo-client`, `tap`, `private`) AND legacy
 * segment IDs (`@north`, `@clientb`, `@own`, `@private`, `@system`) —
 * the service migrates the latter on demand.
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

/** Tag list: deduped, max 32 items, each max 40 chars. */
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
    /** Claude Code session UUID that creates this ticket (handoff point 5). */
    sessionId: z.string().min(1).max(64).optional(),
    /** Workstream container for a multi-agent plan (Phase W). */
    workstreamId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^WS-[A-Za-z0-9]+$/i)
      .optional(),
    /** Parent ticket for hierarchical plans (Phase H). */
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
    /** Claude Code session UUID that initiates this update (handoff point 5). */
    sessionId: z.string().min(1).max(64).optional(),
    /** Workstream container for a multi-agent plan (Phase W). */
    workstreamId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^WS-[A-Za-z0-9]+$/i)
      .optional(),
    /** Parent ticket for hierarchical plans (Phase H). */
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

/**
 * Note/instruction intent (SP-11): comments are reframed as actionable
 * "Anmerkung / Anweisung". The optional `intent` rides in the existing
 * `commented` event payload (free JSON) — NO new event type. `target`
 * optionally names a handoff recipient (e.g. an @mentioned agent/user).
 */
export const CommentIntentSchema = z.enum(["note", "instruction", "question"]);

export const CommentBodySchema = z
  .object({
    text: z.string().min(1, "text required").max(4000),
    actor: ActorSchema.optional(),
    /** Lightweight comment classification — note · instruction · question. */
    intent: CommentIntentSchema.optional(),
    /** Optional handoff target (e.g. "agent:senior-dev", "max"). */
    target: z.string().min(1).max(80).optional(),
  })
  .strict();

export type CommentBody = z.infer<typeof CommentBodySchema>;
export type CommentIntent = z.infer<typeof CommentIntentSchema>;

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
