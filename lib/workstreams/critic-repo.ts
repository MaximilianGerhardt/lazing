// Critic-Repo — substrate writes for workstream_plan_critics.
//
// BACKPORT-03 from Lazing-V2 (2026-05-23 · Agent 3/8). Source:
// lazing-wt/realtime-orchestrator-v2/packages/runtime/src/store/critic-repo.ts
// (verbatim shape — lazyos-stable adapter).
//
// Discipline:
//   - N1: comments_json is persisted verbatim (no .slice in insert).
//   - N8: markSuperseded does NOT delete; only sets superseded_at.
//   - N9: coord_key NOT NULL — caller must validate ManifestCoord before
//     insert (service-layer responsibility).
//   - N10: content_hash = sha256(canonicalJson(payload sans hash)).

import { createHash } from 'node:crypto';

import { getDb } from '@/db/client';
import { ulid } from '@/lib/ulid';
import { workstreamPlanCritics } from '@/db/schema/workstream_plan_critics';
import { and, asc, eq, lte } from 'drizzle-orm';

import type {
  CriticRepo,
  CriticRoundInsert,
  CriticRoundRow,
  CriticRoleName,
  CriticVerdict,
} from '@/lib/critic-loop/types';

/**
 * Canonical JSON — N10. Stable key-ordering so hash is reproducible
 * across re-serialisations.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function nowMs(): number {
  return Date.now();
}

/**
 * Build the SQLite-backed CriticRepo.
 *
 * The repo is intentionally injected into critic-loop.ts via the
 * `CriticRepo` interface — tests can swap in an in-memory fake without
 * touching the FSM.
 */
export function makeCriticRepo(): CriticRepo {
  return {
    writeCriticRound(input: CriticRoundInsert): { row: CriticRoundRow } {
      const db = getDb();
      const id = `CRIT-${ulid()}`;
      const createdAt = nowMs();
      const commentsJson = JSON.stringify(input.comments); // N1: verbatim
      const payload = {
        planStepId: input.planStepId,
        iteration: input.iteration,
        verdict: input.verdict,
        commentsJson,
        criticRole: input.criticRole,
        coordKey: input.coordKey,
        workstreamId: input.workstreamId,
        createdAt,
      };
      const contentHash = sha256(canonicalJson(payload));

      db.insert(workstreamPlanCritics)
        .values({
          id,
          planStepId: input.planStepId,
          iteration: input.iteration,
          verdict: input.verdict,
          commentsJson,
          criticRole: input.criticRole,
          coordKey: input.coordKey,
          workstreamId: input.workstreamId,
          contentHash,
          supersededAt: null,
          createdAt,
        })
        .run();

      const row: CriticRoundRow = {
        id,
        planStepId: input.planStepId,
        iteration: input.iteration,
        verdict: input.verdict,
        commentsJson,
        criticRole: input.criticRole,
        coordKey: input.coordKey,
        workstreamId: input.workstreamId,
        contentHash,
        supersededAt: null,
        createdAt,
      };
      return { row };
    },

    markSuperseded(planStepId, upToIteration, now?: number): void {
      const db = getDb();
      const ts = now ?? nowMs();
      db.update(workstreamPlanCritics)
        .set({ verdict: 'superseded' as CriticVerdict, supersededAt: ts })
        .where(
          and(
            eq(workstreamPlanCritics.planStepId, planStepId),
            lte(workstreamPlanCritics.iteration, upToIteration),
          ),
        )
        .run();
    },

    listRoundsForStep(planStepId: string): readonly CriticRoundRow[] {
      const db = getDb();
      const rows = db
        .select()
        .from(workstreamPlanCritics)
        .where(eq(workstreamPlanCritics.planStepId, planStepId))
        .orderBy(asc(workstreamPlanCritics.iteration))
        .all();
      return rows.map((r) => ({
        id: r.id,
        planStepId: r.planStepId,
        iteration: r.iteration,
        verdict: r.verdict as CriticVerdict,
        commentsJson: r.commentsJson,
        criticRole: r.criticRole as CriticRoleName,
        coordKey: r.coordKey,
        workstreamId: r.workstreamId,
        contentHash: r.contentHash,
        supersededAt: r.supersededAt,
        createdAt: r.createdAt,
      }));
    },
  };
}

/**
 * Verify a critic-row's content_hash matches its payload — INV-19
 * tamper-evidence read-side check. Returns true on match.
 */
export function verifyCriticRoundHash(row: CriticRoundRow): boolean {
  const payload = {
    planStepId: row.planStepId,
    iteration: row.iteration,
    verdict: row.verdict,
    commentsJson: row.commentsJson,
    criticRole: row.criticRole,
    coordKey: row.coordKey,
    workstreamId: row.workstreamId,
    createdAt: row.createdAt,
  };
  return sha256(canonicalJson(payload)) === row.contentHash;
}
