import { warmupEmbedder } from '@/lib/rag/embedder';
async function main() {
  const t0 = Date.now();
  await warmupEmbedder();
  const cold = Date.now() - t0;
  const { retrieve } = await import('@/lib/rag/retriever');
  const t1 = Date.now();
  await retrieve({ workspaceId: 'default', query: 'wie funktioniert der chat', topK: 4 });
  const warm1 = Date.now() - t1;
  const t2 = Date.now();
  await retrieve({ workspaceId: 'default', query: 'noch eine frage', topK: 4 });
  const warm2 = Date.now() - t2;
  console.log('PERF ' + JSON.stringify({ warmupColdMs: cold, retrieveWarm1Ms: warm1, retrieveWarm2Ms: warm2 }));
}
main().then(()=>console.log('done')).catch(e=>console.error('PERF-ERR',e?.message||e));
