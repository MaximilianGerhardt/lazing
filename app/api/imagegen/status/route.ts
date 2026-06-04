/**
 * GET /api/imagegen/status?jobId=IMG-…
 *
 * Pollt den Status eines Bild-Jobs (job-store). Das ImageGenCard-Surface pollt
 * das alle ~2 s, bis status='done' (→ surfaceMarkup/imageUrl) oder 'error'.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getImageJob } from "@/lib/imagegen/job-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId || !/^IMG-[a-z0-9-]{1,40}$/.test(jobId)) {
    return NextResponse.json({ error: "invalid-job-id" }, { status: 400 });
  }
  const job = getImageJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "job-not-found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      jobId: job.id,
      status: job.status,
      elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      ...(job.status === "done"
        ? { imageUrl: job.imageUrl, surfaceMarkup: job.surfaceMarkup, artifactId: job.artifactId }
        : {}),
      ...(job.status === "error" ? { errorCode: job.errorCode, message: job.error } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
