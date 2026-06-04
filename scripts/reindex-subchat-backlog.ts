/**
 * scripts/reindex-subchat-backlog.ts
 *
 * Manuelles/Cron-Pendant zum Auto-Indexer-Self-Heal: zieht alle Sub-Chat-
 * Nachrichten mit ingested=0 (außer System) nachträglich in die Workspace-RAG.
 * Idempotent — bei Erfolg flippt ingested→1, Fehlschläge bleiben für den
 * nächsten Lauf liegen.
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
  // Exit 1, wenn nach dem Lauf noch Rückstand bleibt (Embedder-Problem) — so
  // kann ein Cron/Monitor anschlagen.
  process.exit(res.remaining > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(
    `[reindex-subchat] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
