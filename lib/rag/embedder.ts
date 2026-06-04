/**
 * RAG-Embedder (Sprint 2 / Strang B, 2026-04-30).
 *
 * Lokal-First via @huggingface/transformers v3 — `Xenova/all-MiniLM-L6-v2`.
 * Output: 384-dim float32, mean-pooled, normalisiert (für Cosine ohne
 * Division durch Norm).
 *
 * Benchmark on a typical VPS:
 *   - Pipeline-Init (warm-cache):  ~166ms
 *   - Cold-First-Embed:            ~11ms
 *   - Warm-Avg pro Chunk:          ~6ms (3-15ms range)
 *
 * Lazy-load: Modell wird beim ersten Call gepullt (~25 MB ONNX) und
 * dann im Process-Memory gehalten. KEINE GPU, KEINE Cuda, KEINE API-Credits.
 *
 * MAX-Plan-Konformität: Embedding ist 100% lokal. Keine Anthropic-,
 * OpenAI-, Voyage-, Cohere-Calls.
 *
 * Loop-Guard: Bei Init-Fail > 3 wird der Embedder als „dead" markiert
 * und wirft sofort. Das verhindert Boot-Schleifen wenn das ONNX-Modell
 * korrupt ist (HF-Cache löschen + neu pullen reicht).
 *
 * Hinweis: Wir nutzen @huggingface/transformers (Successor von Xenova v2)
 * weil v2 sharp@0.32 als Hard-Dep zog (sharp Native-Binary fehlt im
 * pnpm-Layout). v3 hat sharp optional und runs on a modern multi-core CPU sub-10ms.
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
    // Dynamic-Import damit Server-Boot ohne RAG-Use die Library nicht zieht.
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
    // dtype: 'q8' = quantized 8-bit (3-4× kleiner als fp32, vergleichbare Qualität).
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
 * Erzeugt einen normalisierten 384-dim Embedding-Vector für einen Text-Chunk.
 * Mean-Pooling + L2-Normalize (für Cosine-Similarity ohne Division).
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
 * Pack-Helper: Float32Array → Buffer (für SQLite-BLOB).
 */
export function packEmbedding(vec: Float32Array): Buffer {
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(`rag-pack-bad-dim: ${vec.length}`);
  }
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Unpack-Helper: Buffer → Float32Array.
 */
export function unpackEmbedding(buf: Buffer): Float32Array {
  if (buf.byteLength !== EMBEDDING_DIM * 4) {
    throw new Error(`rag-unpack-bad-bytes: ${buf.byteLength}`);
  }
  // Zero-Copy: View auf den Buffer.
  return new Float32Array(buf.buffer, buf.byteOffset, EMBEDDING_DIM);
}

/**
 * Cosine-Similarity zweier normalisierter Embeddings.
 * Da beide L2-normalisiert sind: Cosine = Dot-Product. Spart sqrt+div.
 *
 * Returns [-1, +1]. 1 = identisch. 0 = orthogonal.
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
 * Server-Startup-Warmup: lädt die Pipeline vorab damit der erste User-Request
 * nicht die ~166ms ONNX-Init-Latenz trägt. Non-fatal: circuit-open oder fehlendes
 * ONNX-Paket werden still geschluckt (server startet trotzdem).
 *
 * Aufgerufen via Next.js Instrumentation-Hook (`instrumentation.ts` im Repo-Root,
 * `process.env.NEXT_RUNTIME === 'nodejs'`).
 */
export async function warmupEmbedder(): Promise<void> {
  try {
    await getPipeline();
  } catch {
    /* non-fatal: circuit-open (_initFails >= MAX_INIT_FAILS) oder ONNX fehlt */
  }
}

/**
 * Brute-Force Top-K Retrieval. Bei < 50k Chunks unter 30ms auf VPS-CPU.
 * Bei größeren Indizes: Sub-Plan B11 (HNSW) ziehen.
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
