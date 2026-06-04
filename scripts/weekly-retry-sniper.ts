#!/usr/bin/env tsx
/**
 * Weekly Retry Sniper — the real Pattern 9 "Unlearning" (P14, 2026-05-01).
 *
 * Sundays 21:00 (systemd timer): loads unresolved failed experiments older
 * than 14d, re-spawns them with the current model + a fresh perspective, and
 * marks them resolved if the re-try output looks successful.
 *
 * Default is DRY-RUN. `--apply` triggers real re-spawns + DB updates.
 *
 * Hard cap: 5 experiments per run (cost protection, MAX-plan TPM bucket).
 *
 * Resolution heuristic (intentionally conservative):
 *   - output length > 100 chars
 *   - no failure keywords ("geht nicht", "scheitert", "kann nicht")
 *   → markResolved + emitEvent. Otherwise incrementRetryCount.
 *
 * Important (spec):
 *   - NO auto-apply. The sub-ticket path is mandatory.
 *   - Sub-ticket: "Lösung gefunden — vorher fehlgeschlagen am <ts>"
 *   - The real code changes are driven only by a user click in the ticket.
 */

import { emitEvent } from "@/lib/events/emit";
import { MODEL_NAMES } from "@/lib/agents/pricing";
import {
  incrementRetryCount,
  loadUnresolvedExperiments,
  markResolved,
  type FailedExperimentRow,
} from "@/lib/unlearning/experiment-tracker";
import { spawnInTmux, type SpawnArgs } from "@/server/agents/tmux-spawn";
import { ulid } from "@/lib/ulid";

const MAX_RUNS = 5;
const MAX_AGE_DAYS = 14;
const RE_TRY_TIMEOUT_MS = 5 * 60_000;

const FAILURE_KEYWORDS = [
  "geht nicht",
  "scheitert",
  "kann nicht",
  "funktioniert nicht",
  "fehler",
  "error",
  "failed",
  "nicht möglich",
];

function looksSuccessful(output: string): boolean {
  if (output.length <= 100) return false;
  const lower = output.toLowerCase();
  for (const k of FAILURE_KEYWORDS) {
    if (lower.includes(k)) return false;
  }
  return true;
}

function buildSystemPrompt(exp: FailedExperimentRow): string {
  const attemptedAtIso = new Date(exp.attemptedAt).toISOString();
  const reason = exp.failureReason ?? "(kein Grund angegeben)";
  const model = exp.modelUsed ?? "(unbekannt)";
  return [
    "Du arbeitest im Re-Try-Modus für ein Experiment, das in der Vergangenheit fehlgeschlagen ist.",
    `Original-Versuch: ${attemptedAtIso} mit Modell ${model}.`,
    `Damaliger Fehlschlag-Grund: ${reason}`,
    "",
    "Versuche es jetzt erneut mit aktuellem Modell und frischer Perspektive.",
    "Wenn der Versuch jetzt klappt, schreib eine kurze Lösungs-Skizze (Diff-Konzept oder Schritte).",
    "Wenn er weiter scheitert, schreib präzise WARUM — kein Wischiwaschi.",
  ].join("\n");
}

function buildUserPrompt(exp: FailedExperimentRow): string {
  return exp.hypothesis;
}

interface RetryOutcome {
  experimentId: string;
  ok: boolean;
  outputLen: number;
  durationMs: number;
  resolved: boolean;
  note: string;
}

async function retryOne(
  exp: FailedExperimentRow,
  apply: boolean,
): Promise<RetryOutcome> {
  const args: SpawnArgs = {
    workspaceId: exp.workspaceId ?? "lazyos",
    workspacePath: process.cwd(),
    workstreamId: `retry-${exp.id}-${Date.now()}`,
    tier: "opus",
    agentIdx: 0,
    model: MODEL_NAMES.opus,
    systemPrompt: buildSystemPrompt(exp),
    userPrompt: buildUserPrompt(exp),
    timeoutMs: RE_TRY_TIMEOUT_MS,
    maxTurns: 1,
  };

  if (!apply) {
    return {
      experimentId: exp.id,
      ok: true,
      outputLen: 0,
      durationMs: 0,
      resolved: false,
      note: "dry-run",
    };
  }

  try {
    const res = await spawnInTmux(args);
    const success = looksSuccessful(res.text);

    if (success) {
      const note = `Lösung gefunden — vorher fehlgeschlagen am ${new Date(exp.attemptedAt).toISOString()}`;
      markResolved(exp.id, note);

      // Sub-ticket via event (entityType=ticket, ticketId newly generated)
      const ticketId = `tck_${ulid()}`;
      await emitEvent({
        segmentId: (exp.workspaceId as never) ?? "lazyos",
        entityType: "ticket",
        entityId: ticketId,
        eventType: "ticket_created",
        actor: "system",
        payload: {
          source: "weekly-retry-sniper",
          experimentId: exp.id,
          title: note,
          hypothesis: exp.hypothesis,
          previousAttemptedAt: exp.attemptedAt,
          previousModel: exp.modelUsed,
          retryOutputExcerpt: res.text.slice(0, 500),
        },
        sensitivity: "low",
      }).catch(() => undefined);

      return {
        experimentId: exp.id,
        ok: true,
        outputLen: res.text.length,
        durationMs: res.durationMs,
        resolved: true,
        note,
      };
    }

    incrementRetryCount(exp.id);
    return {
      experimentId: exp.id,
      ok: true,
      outputLen: res.text.length,
      durationMs: res.durationMs,
      resolved: false,
      note: "still failing — retry_count++",
    };
  } catch (err) {
    incrementRetryCount(exp.id);
    return {
      experimentId: exp.id,
      ok: false,
      outputLen: 0,
      durationMs: 0,
      resolved: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const all = loadUnresolvedExperiments(MAX_AGE_DAYS);
  const candidates = all.slice(0, MAX_RUNS);

  if (candidates.length === 0) {
    console.log(
      JSON.stringify({
        ok: true,
        applied: apply,
        total: 0,
        retried: 0,
        resolved: 0,
        note: "no unresolved experiments older than maxAgeDays",
      }),
    );
    return;
  }

  const outcomes: RetryOutcome[] = [];
  for (const exp of candidates) {
    const out = await retryOne(exp, apply);
    outcomes.push(out);
  }

  const resolved = outcomes.filter((o) => o.resolved).length;
  const failed = outcomes.filter((o) => !o.ok).length;

  // Summary event on the 'lazyos' segment: eventType='experiment_retry_batch'
  if (apply) {
    await emitEvent({
      segmentId: "lazyos",
      entityType: "phase",
      entityId: `experiment_retry_batch_${Date.now()}`,
      // eventType not in the official enum — we route via push_sent
      // with a payload discriminator. The spec requires 'experiment_retry_batch'
      // → we deliver that in payload.kind, and use 'workflow.completed'
      // as the closest official event type.
      eventType: "workflow.completed",
      actor: "system",
      payload: {
        kind: "experiment_retry_batch",
        total: candidates.length,
        retried: outcomes.length,
        resolved,
        failed,
        outcomes: outcomes.map((o) => ({
          experimentId: o.experimentId,
          resolved: o.resolved,
          outputLen: o.outputLen,
          durationMs: o.durationMs,
          note: o.note,
        })),
      },
      sensitivity: "low",
    }).catch(() => undefined);
  }

  console.log(
    JSON.stringify({
      ok: true,
      applied: apply,
      total: all.length,
      retried: outcomes.length,
      resolved,
      failed,
      cap: MAX_RUNS,
      maxAgeDays: MAX_AGE_DAYS,
      outcomes,
    }),
  );
}

main()
  .then(() => {
    // DB loops (stuck-detector, etc.) block the process exit. Hard exit.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
