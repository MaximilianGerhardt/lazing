/**
 * RAG-Retrieve-Bench (Pattern 3 MVP, 2026-05-01).
 *
 * 20 fixe Test-Queries (mix code/status/history/unknown) — pro Query
 * Top-5 Hits mit sourceType + similarity + routedScore + erkanntem Intent.
 * Ziel: visueller Compare durch User, ob der Source-Router die richtigen
 * Treffer nach oben holt.
 *
 * Run: `pnpm exec tsx scripts/rag-retrieve-bench.ts`
 */

import { retrieve } from '@/lib/rag/retriever';

const queries: { intent: string; q: string }[] = [
  // CODE
  { intent: 'code', q: 'wie funktioniert der indexer' },
  { intent: 'code', q: 'fix the TypeError in retriever.ts' },
  { intent: 'code', q: 'refactor the embedder class' },
  { intent: 'code', q: 'wie ist die import-Struktur in lib/rag' },
  { intent: 'code', q: 'implement function for cosine similarity' },
  // STATUS
  { intent: 'status', q: 'wo stehen wir mit dem ticket' },
  { intent: 'status', q: 'sprint status update' },
  { intent: 'status', q: 'welche tasks sind blocked' },
  { intent: 'status', q: 'was ist offen im work-product' },
  { intent: 'status', q: 'welche deadlines kommen' },
  // HISTORY
  { intent: 'history', q: 'warum haben wir damals den Tier-Orchestrator gebaut' },
  { intent: 'history', q: 'gestern haben wir besprochen' },
  { intent: 'history', q: 'was wurde letzte woche gesagt zu Push-Priority' },
  { intent: 'history', q: 'die entscheidung im chat zu RAG' },
  { intent: 'history', q: 'warum sniper-loop' },
  // UNKNOWN
  { intent: 'unknown', q: 'Lorem Ipsum dolor sit amet' },
  { intent: 'unknown', q: 'Brand laz.ing UI-String-Update' },
  { intent: 'unknown', q: 'Open-Questions QuickChoice OPTIONS' },
  { intent: 'unknown', q: 'RAG-Indexer Embedder Cosine' },
  { intent: 'unknown', q: 'irgendwas zu workspaces' },
];

async function main(): Promise<void> {
  for (const { intent: expected, q } of queries) {
    const t0 = Date.now();
    const r = await retrieve({ workspaceId: 'lazyos', query: q, topK: 5 });
    const ms = Date.now() - t0;
    const intentMatch = r.intent === expected ? '✓' : '✗';
    console.log(
      `Q [${expected}/${r.intent} ${intentMatch}]: ${q}`,
    );
    console.log(
      `   ${r.hits.length} hits, ${r.totalCandidates} cand, ${r.approxTokens} tok, ${ms}ms`,
    );
    for (const h of r.hits.slice(0, 5)) {
      const id = h.sourceId.length > 40 ? h.sourceId.slice(0, 40) + '…' : h.sourceId;
      const sim = h.similarity.toFixed(3);
      const rs = h.routedScore !== undefined ? h.routedScore.toFixed(3) : '—';
      console.log(`   - ${h.sourceType.padEnd(13)} ${id.padEnd(42)} sim=${sim} routed=${rs}`);
    }
    console.log();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
