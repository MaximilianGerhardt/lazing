/**
 * Phase CTX — Plan-File-Writer (Phase Vercel-NFT-Fix 2026-04-29).
 *
 * Public wrapper. The real implementation lives in `plan-writer.impl.ts` and
 * is loaded at runtime via dynamic import, so that Vercel-Turbopack NFT
 * tracing does not treat the whole fs tree as an asset.
 */

export interface PrependResult {
  planPath: string;
  bytesWritten: number;
  snapshotsRetained: number;
}

export async function prependPlanSnapshot(
  block: string,
  planPathOverride?: string,
): Promise<PrependResult> {
  const impl = await import("./plan-writer.impl");
  return impl.prependPlanSnapshot(block, planPathOverride);
}

export async function appendPlanLine(
  line: string,
  planPathOverride?: string,
): Promise<void> {
  const impl = await import("./plan-writer.impl");
  return impl.appendPlanLine(line, planPathOverride);
}
