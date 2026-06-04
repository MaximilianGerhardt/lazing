/**
 * scripts/reindex-subchat-backlog.ts
 *
 * Manual/cron counterpart to the auto-indexer self-heal: pulls all sub-chat
 * messages with ingested=0 (except system) into the workspace RAG after the
 * fact. Idempotent — on success ingested flips to 1, failures remain for the
 * next run.
 *
 * Usage:
 *   pnpm tsx scripts/reindex-subchat-backlog.ts
 */
import { reindexUningestedSubchats } from "../lib/subchats/service";

async function main(): Promise<void> {
  const res = await reindexUningestedSubchats(1000);
  process.stdout.write(
    `[reindex-subchat] attempted=${res.attempted} remaining=${res.remaining}\n`,
  );
  // Exit 1 if a backlog remains after the run (embedder problem) — so a
  // cron/monitor can trigger.
  process.exit(res.remaining > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(
    `[reindex-subchat] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
