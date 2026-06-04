// Critic-Loop shared types — BACKPORT-03 (2026-05-23).
//
// In Lazing-V2, CriticRepo/CriticVerdict/CriticComment/CriticRoundRow live in
// the @lazing/runtime package. lazyos-stable has no monorepo split — we
// inline the types here so critic-loop.ts lives without external deps.
// Identical shapes to V2 (comparable). Single source of truth for the
// FSM and for lib/workstreams/critic-repo.ts.

export type CriticVerdict = 'pass' | 'conditional' | 'fail' | 'superseded';

export type CriticRoleName = 'critic' | 'cross-roast' | 'operator';

export interface CriticComment {
  readonly role: string;
  readonly text: string;
  readonly severity: string;
}

export interface CriticRoundRow {
  readonly id: string;
  readonly planStepId: string;
  readonly iteration: number;
  readonly verdict: CriticVerdict;
  readonly commentsJson: string;
  readonly criticRole: CriticRoleName;
  readonly coordKey: string;
  readonly workstreamId: string | null;
  readonly contentHash: string;
  readonly supersededAt: number | null;
  readonly createdAt: number;
}

export interface CriticRoundInsert {
  readonly planStepId: string;
  readonly iteration: number;
  readonly verdict: CriticVerdict;
  readonly comments: readonly CriticComment[];
  readonly criticRole: CriticRoleName;
  readonly coordKey: string;
  readonly workstreamId: string | null;
}

export interface CriticRepo {
  /** Persist a critic round. Returns the inserted row (hash-stamped). */
  readonly writeCriticRound: (
    input: CriticRoundInsert,
  ) => { readonly row: CriticRoundRow };
  /** Mark earlier rounds for a step as superseded (soft-mark, no DELETE). */
  readonly markSuperseded: (
    planStepId: string,
    upToIteration: number,
    now?: number,
  ) => void;
  /** Read all rounds for a step in iteration order. */
  readonly listRoundsForStep: (
    planStepId: string,
  ) => readonly CriticRoundRow[];
}
