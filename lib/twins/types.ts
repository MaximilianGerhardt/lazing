/**
 * Pattern 2 Digital-Twin MVP — Type-Definitionen.
 *
 * Twins sind strukturierte JSON-Blöcke (owner twin = User-Profil,
 * Domain-Twin = Workspace-Snapshot), die als kompakter `<TWIN_*>{...}</TWIN_*>`
 * Block in den System-Prompt jedes Sub-Agents injiziert werden.
 *
 * Vorher: jeder Sub-Agent las CLAUDE.md+MEMORY.md+Standards (~10K Tokens).
 * Nachher: ein einziger validierter JSON-Block (~500 Tokens), der alle
 * relevanten Regeln/Vetos/Sensitivity-Themen kompakt transportiert.
 */

import { z } from "zod";

export const MaxTwinSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  stil: z.object({
    sprache: z.enum(["de", "en"]),
    ton: z.enum(["direkt-knapp", "formell", "locker"]),
    format_pref: z.enum(["surface-first", "markdown", "plain"]),
    max_woerter_default: z.number().int().min(100).max(5000),
    duzen: z.boolean(),
    emojis: z.boolean(),
  }),
  veto_regeln: z
    .array(
      z.object({
        id: z.string(),
        rule: z.string().max(200),
        quelle: z.string().optional(),
      }),
    )
    .max(20),
  projekte_aktiv: z.array(
    z.object({
      id: z.string(),
      rolle: z.string(),
      phase: z.string().nullable().optional(),
      sensitivity: z.enum(["low", "high"]).optional(),
    }),
  ),
  sensitive_themen: z.array(z.string()).max(15),
  exit_ziel: z.object({
    horizon: z.string(),
    beschreibung: z.string().max(300),
    done_signal: z.string().max(200),
  }),
});

export type OwnerTwin = z.infer<typeof MaxTwinSchema>;

export interface DomainTwin {
  workspaceId: string;
  workspaceLabel: string | null;
  workspaceType: string | null;
  sensitivity: "low" | "high";
  accent: string | null;
  activeWorkstreams: number;
  recentDecisions: string[];
  openTicketsP0P1: number;
}
