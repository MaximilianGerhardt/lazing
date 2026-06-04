/**
 * innovation_artifacts — Repo (Migration 0121 · Lane D Innovation Mode).
 *
 * Arbeitsweise (analog lib/reasoning/beliefs-repo.ts):
 *   - Nimmt ein ROHES better-sqlite3-Handle entgegen — kein getDb()-Singleton,
 *     direkt in-memory testbar. Der Caller loest das Handle via
 *     `(await import('@/db/client')).getDb().$raw` auf (fail-soft).
 *   - N1:  content / source_json werden VERBATIM persistiert (kein .slice).
 *   - N9:  jede Row traegt workspace_id (ManifestCoord-Scope).
 *   - N10: content_hash (sha256 ueber kanonisches JSON) je Row; gleicher
 *          Inhalt → gleicher Hash → idempotenter Re-Run (kein Doppel-Insert).
 *   - N8:  append-only (Trigger in 0121). Eine Korrektur ist eine neue Row mit
 *          supersedesId.
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

export type InnovationArtifactKind =
  | "assumption"
  | "reframe"
  | "cross-domain-analogy"
  | "contrarian-roast"
  | "concept-node"
  | "concept-edge";

export interface InnovationArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: InnovationArtifactKind;
  /** Kern-Aussage, VERBATIM (N1). */
  readonly content: string;
  /** JSON-Provenienz oder null. */
  readonly sourceJson: string | null;
  readonly supersedesId: string | null;
  readonly contentHash: string;
  readonly createdAt: number;
}

export interface InsertArtifactInput {
  readonly workspaceId: string;
  readonly kind: InnovationArtifactKind;
  readonly content: string;
  /** Provenienz-Objekt; wird kanonisch serialisiert + verbatim gespeichert. */
  readonly source?: Record<string, unknown>;
  readonly supersedesId?: string | null;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Kanonischer sha256 ueber das identitaetsbestimmende JSON (N10). Schluessel
 * sortiert → deterministisch. Identischer Inhalt im selben Workspace → gleicher
 * Hash → idempotenter Re-Run.
 */
function sha256hex(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Schreibt EIN Innovation-Artefakt (append-only). Idempotent: existiert bereits
 * eine Row mit identischem content_hash im selben Workspace, wird die bestehende
 * Row zurueckgegeben (kein Doppel-Insert) — so darf ein Innovation-Run
 * gefahrlos wiederholt werden (N6/N10).
 */
export function insertArtifact(
  raw: RawDb,
  input: InsertArtifactInput,
): InnovationArtifact {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("insertArtifact: workspaceId required (N9)");
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new Error("insertArtifact: content required");
  }

  const sourceJson =
    input.source === undefined ? null : JSON.stringify(input.source);
  const supersedesId = input.supersedesId ?? null;

  const contentHash = sha256hex({
    workspace_id: input.workspaceId,
    kind: input.kind,
    content: input.content, // N1: verbatim in den Hash
    source_json: sourceJson,
    supersedes_id: supersedesId,
  });

  // Idempotenz: gleicher Inhalt schon da? → bestehende Row zurueck.
  const existing = raw
    .prepare(
      `SELECT id, workspace_id, kind, content, source_json, supersedes_id,
              content_hash, created_at
         FROM innovation_artifacts
        WHERE workspace_id = ? AND content_hash = ?
        LIMIT 1`,
    )
    .get(input.workspaceId, contentHash) as RawRow | undefined;
  if (existing) return mapRow(existing);

  const row: InnovationArtifact = {
    id: `INV-${ulid()}`,
    workspaceId: input.workspaceId,
    kind: input.kind,
    content: input.content, // N1: verbatim
    sourceJson,
    supersedesId,
    contentHash,
    createdAt: nowMs(),
  };

  raw
    .prepare(
      `INSERT INTO innovation_artifacts
         (id, workspace_id, kind, content, source_json, supersedes_id,
          content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.kind,
      row.content,
      row.sourceJson,
      row.supersedesId,
      row.contentHash,
      row.createdAt,
    );

  return row;
}

interface RawRow {
  id: string;
  workspace_id: string;
  kind: string;
  content: string;
  source_json: string | null;
  supersedes_id: string | null;
  content_hash: string;
  created_at: number;
}

function mapRow(r: RawRow): InnovationArtifact {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as InnovationArtifactKind,
    content: r.content,
    sourceJson: r.source_json,
    supersedesId: r.supersedes_id,
    contentHash: r.content_hash,
    createdAt: r.created_at,
  };
}

/** Liest alle Artefakte eines Workspace, optional nach Kind gefiltert. */
export function listArtifacts(
  raw: RawDb,
  args: { workspaceId: string; kind?: InnovationArtifactKind },
): InnovationArtifact[] {
  const rows = args.kind
    ? (raw
        .prepare(
          `SELECT id, workspace_id, kind, content, source_json, supersedes_id,
                  content_hash, created_at
             FROM innovation_artifacts
            WHERE workspace_id = ? AND kind = ?
            ORDER BY created_at ASC, id ASC`,
        )
        .all(args.workspaceId, args.kind) as RawRow[])
    : (raw
        .prepare(
          `SELECT id, workspace_id, kind, content, source_json, supersedes_id,
                  content_hash, created_at
             FROM innovation_artifacts
            WHERE workspace_id = ?
            ORDER BY created_at ASC, id ASC`,
        )
        .all(args.workspaceId) as RawRow[]);
  return rows.map(mapRow);
}
