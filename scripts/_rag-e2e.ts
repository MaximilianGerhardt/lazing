import { retrieve } from '@/lib/rag/retriever';
async function main() {
  // Query gegen die 45 indizierten default-Chunks (lexical-first FTS).
  const r = await retrieve({ workspaceId: 'default', query: 'chat lazyos plan workstream', topK: 5 });
  const allDefault = r.hits.every((h:any) => h.workspaceId === 'default');
  console.log('RAGE2E ' + JSON.stringify({
    hits: r.hits.length,
    totalCandidates: r.totalCandidates,
    intent: r.intent,
    allHitsWorkspaceDefault: allDefault,
    firstSim: r.hits[0]?.similarity ?? null,
  }));
  // Isolation: query gegen einen leeren/anderen Workspace darf KEINE default-Chunks geben
  const other = await retrieve({ workspaceId: 'intern', query: 'chat lazyos plan workstream', topK: 5 });
  const leak = other.hits.some((h:any) => h.workspaceId === 'default');
  console.log('RAGISO ' + JSON.stringify({ internHits: other.hits.length, leakedDefault: leak }));
}
main().then(()=>console.log('done')).catch(e=>console.error('E2E-ERR', e?.message||e));
