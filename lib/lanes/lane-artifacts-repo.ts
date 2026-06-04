/**
 * lane_artifacts — gemeinsames Repo (Migration 0122 · Lanes C/E/F).
 *
 * Geteiltes Substrat-Modul fuer die drei Discovery-Lane-Engines:
 *   - Lane C  lib/lanes/role-reverse/
 *   - Lane E  lib/lanes/toolstack/
 *   - Lane F  lib/lanes/mobile-hitl/
 *
 * Arbeitsweise (analog lib/innovate/artifacts-repo.ts):
 *   - Nimmt ein ROHES better-sqlite3-Handle entgegen — kein getDb()-Singleton,
 *     direkt in-memory testbar.
 *   - N1:  content / source_json werden VERBATIM persistiert (kein .slice).
 *   - N9:  jede Row traegt workspace_id (ManifestCoord-Scope).
 *   - N10: content_hash (sha256 ueber kanonisches JSON) je Row; gleicher
 *          Inhalt → gleicher Hash → idempotenter Re-Run (kein Doppel-Insert).
 *   - N8:  append-only (Trigger in 0122). Eine Korrektur ist eine neue Row mit
 *          supersedesId.
 */

import { createHash } from "node:crypto";

import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

/** Die Discovery-Lane (CHECK in 0122). */
export type LaneId = "c" | "e" | "f";

/** Alle Artefakt-Arten (CHECK in 0122). */
export type LaneArtifactKind =
  // Lane C — Role Reverse Engineering
  | "role-model"
  | "decision-map"
  | "dependency-map"
  | "automation-boundary"
  // Lane E — Toolstack Replacement
  | "tool-replacement"
  // Lane F — Mobile Human-in-the-Loop
  | "hitl-rule";

export const LANE_ARTIFACT_KINDS: readonly LaneArtifactKind[] = [
  "role-model",
  "decision-map",
  "dependency-map",
  "automation-boundary",
  "tool-replacement",
  "hitl-rule",
] as const;

/** Welche kind gehoert zu welcher Lane (deterministisch, N6). */
export const KIND_TO_LANE: Readonly<Record<LaneArtifactKind, LaneId>> =
  Object.freeze({
    "role-model": "c",
    "decision-map": "c",
    "dependency-map": "c",
    "automation-boundary": "c",
    "tool-replacement": "e",
    "hitl-rule": "f",
  });

const KIND_SET = new Set<string>(LANE_ARTIFACT_KINDS);

export interface LaneArtifact {
  readonly id: string;
  readonly workspaceId: string;
  readonly lane: LaneId;
  readonly kind: LaneArtifactKind;
  /** Kern-Aussage, VERBATIM (N1). */
  readonly content: string;
  /** JSON-Provenienz/Struktur oder null. */
  readonly sourceJson: string | null;
  readonly supersedesId: string | null;
  readonly contentHash: string;
  readonly createdAt: number;
}

export interface InsertLaneArtifactInput {
  readonly workspaceId: string;
  readonly kind: LaneArtifactKind;
  readonly content: string;
  /** Strukturierte Provenienz/Payload; wird kanonisch serialisiert + verbatim gespeichert. */
  readonly source?: Record<string, unknown>;
  readonly supersedesId?: string | null;
  /** Test-Override fuer created_at. Default Date.now(). */
  readonly nowMs?: number;
}

/** N10: kanonischer sha256 ueber das identitaetsbestimmende JSON. */
function sha256hex(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

interface RawRow {
  id: string;
  workspace_id: string;
  lane: string;
  kind: string;
  content: string;
  source_json: string | null;
  supersedes_id: string | null;
  content_hash: string;
  created_at: number;
}

function mapRow(r: RawRow): LaneArtifact {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    lane: r.lane as LaneId,
    kind: r.kind as LaneArtifactKind,
    content: r.content,
    sourceJson: r.source_json,
    supersedesId: r.supersedes_id,
    contentHash: r.content_hash,
    createdAt: r.created_at,
  };
}

/**
 * Schreibt EIN lane_artifact (append-only). Idempotent: existiert bereits eine
 * Row mit identischem content_hash im selben Workspace, wird die bestehende Row
 * zurueckgegeben (kein Doppel-Insert) — ein Lane-Run darf gefahrlos wiederholt
 * werden (N6/N10). Die `lane` wird deterministisch aus dem `kind` abgeleitet
 * (KIND_TO_LANE) — kein Caller kann lane/kind inkonsistent setzen.
 */
export function insertLaneArtifact(
  raw: RawDb,
  input: InsertLaneArtifactInput,
): LaneArtifact {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("insertLaneArtifact: workspaceId required (N9)");
  }
  if (typeof input.kind !== "string" || !KIND_SET.has(input.kind)) {
    throw new Error(`insertLaneArtifact: invalid kind '${String(input.kind)}'`);
  }
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new Error("insertLaneArtifact: content required (N1)");
  }

  const lane = KIND_TO_LANE[input.kind];
  const sourceJson =
    input.source === undefined ? null : JSON.stringify(input.source);
  const supersedesId = input.supersedesId ?? null;

  const contentHash = sha256hex({
    workspace_id: input.workspaceId,
    lane,
    kind: input.kind,
    content: input.content, // N1: verbatim in den Hash
    source_json: sourceJson,
    supersedes_id: supersedesId,
  });

  const existing = raw
    .prepare(
      `SELECT id, workspace_id, lane, kind, content, source_json, supersedes_id,
              content_hash, created_at
         FROM lane_artifacts
        WHERE workspace_id = ? AND content_hash = ?
        LIMIT 1`,
    )
    .get(input.workspaceId, contentHash) as RawRow | undefined;
  if (existing) return mapRow(existing);

  const row: LaneArtifact = {
    id: `LNA-${ulid()}`,
    workspaceId: input.workspaceId,
    lane,
    kind: input.kind,
    content: input.content, // N1: verbatim
    sourceJson,
    supersedesId,
    contentHash,
    createdAt: Number.isFinite(input.nowMs)
      ? (input.nowMs as number)
      : Date.now(),
  };

  raw
    .prepare(
      `INSERT INTO lane_artifacts
         (id, workspace_id, lane, kind, content, source_json, supersedes_id,
          content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.lane,
      row.kind,
      row.content,
      row.sourceJson,
      row.supersedesId,
      row.contentHash,
      row.createdAt,
    );

  return row;
}

/** Liest alle Lane-Artefakte eines Workspace, optional nach lane und/oder kind gefiltert. */
export function listLaneArtifacts(
  raw: RawDb,
  args: { workspaceId: string; lane?: LaneId; kind?: LaneArtifactKind },
): LaneArtifact[] {
  const clauses = ["workspace_id = ?"];
  const params: unknown[] = [args.workspaceId];
  if (args.lane) {
    clauses.push("lane = ?");
    params.push(args.lane);
  }
  if (args.kind) {
    clauses.push("kind = ?");
    params.push(args.kind);
  }
  const rows = raw
    .prepare(
      `SELECT id, workspace_id, lane, kind, content, source_json, supersedes_id,
              content_hash, created_at
         FROM lane_artifacts
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at ASC, id ASC`,
    )
    .all(...params) as RawRow[];
  return rows.map(mapRow);
}
