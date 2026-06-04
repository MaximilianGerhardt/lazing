/**
 * Work-Products — Zod-Schemas (shared Frontend & Backend).
 *
 * Sprint 2 · Section 7I. Work-Products sind Artefakte, die pro Ticket
 * abgelegt werden koennen (Agent-Output, User-Uploads, Reports).
 *
 * Scope (Sprint 2):
 *   - markdown + url: voll unterstuetzt (Render + Create).
 *   - code_diff | pdf | email | json: als Type akzeptiert, Render als
 *     pre-formatted Fallback. Dediziertes Rendering in Sprint 3.
 */

import { z } from "zod";

import { ActorSchema } from "../tickets/schema";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const WorkProductTypeSchema = z.enum([
  "markdown",
  "url",
  "code_diff",
  "pdf",
  "email",
  "json",
]);

export type WorkProductType = z.infer<typeof WorkProductTypeSchema>;

export const WorkProductStatusSchema = z.enum([
  "draft",
  "final",
  "superseded",
]);

export type WorkProductStatus = z.infer<typeof WorkProductStatusSchema>;

/**
 * MIME-Type — optional und defensiv typisiert. Wir erlauben jeden
 * nicht-whitespace String bis 120 Zeichen; strikte Validation waere
 * mehr Ballast als Nutzen (clients senden ohnehin oft abweichende
 * Casings).
 */
export const MimeSchema = z.string().trim().min(1).max(120);

// ---------------------------------------------------------------------------
// Create / Update
// ---------------------------------------------------------------------------

export const CreateWorkProductBodySchema = z
  .object({
    type: WorkProductTypeSchema,
    title: z.string().min(1, "title required").max(200),
    /**
     * Inline-Content fuer markdown/url/json/email/code_diff. Bei `pdf`
     * ist das der relative Pfad (wird unten validiert — Pfadtrennzeichen
     * erlaubt, aber keine `..`).
     *
     * Groesse: bis 500 KB inline. Wenn groesser: klient muss vorher
     * zu externem Storage pushen und nur URL hinterlegen.
     */
    content: z.string().max(500_000),
    mime: MimeSchema.optional(),
    status: WorkProductStatusSchema.optional(),
    actor: ActorSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // URL-Type: content muss eine valide URL sein.
    if (val.type === "url") {
      try {
        const u = new URL(val.content);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["content"],
            message: "url must use http(s) scheme",
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content"],
          message: "url must be a valid absolute URL",
        });
      }
    }

    // JSON-Type: content muss parsebar sein.
    if (val.type === "json") {
      try {
        JSON.parse(val.content);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content"],
          message: "json content must be parseable JSON",
        });
      }
    }

    // PDF-Type: content ist Pfad unter ~/.lazyos/work-products/.
    if (val.type === "pdf") {
      if (val.content.includes("..")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content"],
          message: "path traversal not allowed",
        });
      }
    }
  });

export type CreateWorkProductBody = z.infer<
  typeof CreateWorkProductBodySchema
>;

export const UpdateWorkProductBodySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    content: z.string().max(500_000).optional(),
    mime: MimeSchema.optional(),
    status: WorkProductStatusSchema.optional(),
    actor: ActorSchema.optional(),
  })
  .strict()
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    { message: "at least one field required" },
  );

export type UpdateWorkProductBody = z.infer<
  typeof UpdateWorkProductBodySchema
>;

// ---------------------------------------------------------------------------
// Read-Model
// ---------------------------------------------------------------------------

export interface WorkProduct {
  id: string; // WP-<nanoid(10)>
  ticketId: string;
  type: WorkProductType;
  title: string;
  content: string;
  mime: string | null;
  bytes: number;
  status: WorkProductStatus;
  createdBy: string; // 'user' | 'user:<name>' | 'agent:<agent-name>'
  createdAt: number;
  updatedAt: number;
}
