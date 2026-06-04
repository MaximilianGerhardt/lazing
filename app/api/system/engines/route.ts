/**
 * GET /api/system/engines
 *
 * Returns the multi-engine availability matrix:
 *
 *   {
 *     "preferred": "claude-cli" | "codex-cli" | "ollama" | null,
 *     "detectedAt": <ms>,
 *     "available": [
 *       { "engine": "claude-cli", "available": true, "reason": "...", ... },
 *       ...
 *     ]
 *   }
 *
 * Cache: 60s in-process (see selector.ts). Pass `?fresh=1` to force probe.
 */

import { NextResponse } from 'next/server';
import { detectEngines } from '../../../../lib/llm/engines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const fresh = url.searchParams.get('fresh') === '1';
  try {
    const selection = await detectEngines({ forceProbe: fresh });
    return NextResponse.json(selection, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'engine_detect_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
