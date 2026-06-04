/**
 * RAG embedder (Sprint 2 / strand B, 2026-04-30).
 *
 * Local-first via @huggingface/transformers v3 — `Xenova/all-MiniLM-L6-v2`.
 * Output: 384-dim float32, mean-pooled, normalized (for cosine without
 * division by the norm).
 *
 * Benchmark on a typical VPS:
 *   - Pipeline init (warm cache):  ~166ms
 *   - Cold first embed:            ~11ms
 *   - Warm avg per chunk:          ~6ms (3-15ms range)
 *
 * Lazy-load: the model is pulled on the first call (~25 MB ONNX) and
 * then kept in process memory. NO GPU, NO Cuda, NO API credits.
 *
 * MAX-plan compliance: embedding is 100% local. No Anthropic,
 * OpenAI, Voyage, or Cohere calls.
 *
 * Loop-guard: after init-fail > 3 the embedder is marked „dead"
 * and throws immediately. This prevents boot loops when the ONNX model
 * is corrupt (deleting the HF cache + re-pulling is enough).
 *
 * Note: we use @huggingface/transformers (successor of Xenova v2)
 * because v2 pulled sharp@0.32 as a hard dep (the sharp native binary is missing in the
 * pnpm layout). v3 has sharp optional and runs on a modern multi-core CPU sub-10ms.
 */

let _pipeline: ((text: string, opts: object) => Promise<{ data: Float32Array }>) | null = null;
let _initFails = 0;
const MAX_INIT_FAILS = 3;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIM = 384 as const;

async function getPipeline(): Promise<
  (text: string, opts: object) => Promise<{ data: Float32Array }>
> {
  if (_pipeline) return _pipeline;
  if (_initFails >= MAX_INIT_FAILS) {
    throw new Error('rag-embedder-circuit-open');
  }
  try {
    // Dynamic import so the server boot does not pull the library without RAG use.
    const tx = (await import('@huggingface/transformers')) as unknown as {
      env: { allowLocalModels: boolean; useBrowserCache: boolean; cacheDir?: string };
      pipeline: (
        task: string,
        model: string,
        opts: object,
      ) => Promise<(text: string, opts: object) => Promise<{ data: Float32Array }>>;
    };
    tx.env.allowLocalModels = true;
    tx.env.useBrowserCache = false;
    if (process.env.LAZYOS_RAG_CACHE_DIR) {
      tx.env.cacheDir = process.env.LAZYOS_RAG_CACHE_DIR;
    }
    // dtype: 'q8' = quantized 8-bit (3-4× smaller than fp32, comparable quality).
    const pipeline = await tx.pipeline('feature-extraction', MODEL_NAME, {
      dtype: 'q8',
    });
    _pipeline = pipeline as typeof _pipeline & object;
    return _pipeline!;
  } catch (err) {
    _initFails += 1;
    throw new Error(
      `rag-embedder-init-failed (${_initFails}/${MAX_INIT_FAILS}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Produces a normalized 384-dim embedding vector for a text chunk.
 * Mean-pooling + L2-normalize (for cosine similarity without division).
 */
export async function embed(text: string): Promise<Float32Array> {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('rag-embedder-empty-text');
  }
  const pipe = await getPipeline();
  const out = await pipe(text, { pooling: 'mean', normalize: true });
  if (!out || !out.data || out.data.length !== EMBEDDING_DIM) {
    throw new Error(`rag-embedder-bad-output: dim=${out?.data?.length ?? 0}`);
  }
  return out.data;
}

/**
 * Pack helper: Float32Array → Buffer (for SQLite BLOB).
 */
export function packEmbedding(vec: Float32Array): Buffer {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`rag-pack-bad-dim: ${vec.length}`);
  }
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Unpack helper: Buffer → Float32Array.
 */
export function unpackEmbedding(buf: Buffer): Float32Array {
  if (buf.byteLength !== EMBEDDING_DIM * 4) {
    throw new Error(`rag-unpack-bad-bytes: ${buf.byteLength}`);
  }
  // Zero-copy: a view onto the buffer.
  return new Float32Array(buf.buffer, buf.byteOffset, EMBEDDING_DIM);
}

/**
 * Cosine similarity of two normalized embeddings.
 * Since both are L2-normalized: cosine = dot product. Saves sqrt+div.
 *
 * Returns [-1, +1]. 1 = identical. 0 = orthogonal.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine-dim-mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Server-startup warmup: pre-loads the pipeline so the first user request
 * does not carry the ~166ms ONNX init latency. Non-fatal: circuit-open or a missing
 * ONNX package are swallowed silently (the server starts anyway).
 *
 * Called via the Next.js instrumentation hook (`instrumentation.ts` at the repo root,
 * `process.env.NEXT_RUNTIME === 'nodejs'`).
 */
export async function warmupEmbedder(): Promise<void> {
  try {
    await getPipeline();
  } catch {
    /* non-fatal: circuit-open (_initFails >= MAX_INIT_FAILS) or ONNX missing */
  }
}

/**
 * Brute-force top-K retrieval. Under 30ms on VPS CPU for < 50k chunks.
 * For larger indices: pull in Sub-Plan B11 (HNSW).
 */
export interface RetrievalCandidate {
  id: string;
  similarity: number;
}
export function topK(
  query: Float32Array,
  candidates: ReadonlyArray<{ id: string; embedding: Float32Array }>,
  k: number,
): RetrievalCandidate[] {
  const scored: RetrievalCandidate[] = candidates.map((c) => ({
    id: c.id,
    similarity: cosineSimilarity(query, c.embedding),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, Math.max(0, k));
}
