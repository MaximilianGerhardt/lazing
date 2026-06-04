// HF-Transformers v4 probe — sharp-frei?
const tx = await import('@huggingface/transformers');
console.log('keys (first 12):', Object.keys(tx).slice(0, 12));
console.log('pipeline:', typeof tx.pipeline);
console.log('env.cacheDir:', tx.env.cacheDir);
console.log('env.allowLocalModels:', tx.env.allowLocalModels);
console.log('env.useBrowserCache:', tx.env.useBrowserCache);
console.log('--- create feature-extraction pipeline ---');
const t0 = Date.now();
const pipe = await tx.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
console.log('pipeline-init=', Date.now() - t0, 'ms');
const t1 = Date.now();
const out = await pipe('Surface-First OS für Solo-Builder', { pooling: 'mean', normalize: true });
console.log('embed=', Date.now() - t1, 'ms, dim=', out.data.length);
console.log('first-3:', Array.from(out.data.slice(0, 3)).map(v => v.toFixed(4)));
const warm = [];
for (const text of [
  'tier-orchestrator runIterate spawns Lead+Roaster+Synthesis',
  'RAG-Pro-Workspace lokale Embeddings via HuggingFace',
  'Symbolic Guards parsePlanQuestions checkOptionsQuota',
  'lazyOS Display-Brand laz.ing storage bleibt lazyos',
  'Apple-Pure-Design Manifest white-editorial Rams',
]) {
  const t = Date.now();
  await pipe(text, { pooling: 'mean', normalize: true });
  warm.push(Date.now() - t);
}
const avg = Math.round(warm.reduce((s, v) => s + v, 0) / warm.length);
console.log('warm-avg=', avg, 'ms over', warm.length, 'samples', warm);
