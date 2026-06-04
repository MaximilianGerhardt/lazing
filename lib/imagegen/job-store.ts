/**
 * lib/imagegen/job-store.ts — asynchronous image-generation job (2026-06-03).
 *
 * Owner finding: the synchronous /api/imagegen/generate blocked ~30–90 s →
 * ran into a timeout through the cloudflared proxy („Fehler, kein Bild") and
 * showed only static toast text instead of an animated loading surface.
 *
 * Solution: the job runs in the BACKGROUND. `startImageJob` immediately returns
 * a jobId; the surface (ImageGenCard) polls `getJob` and meanwhile shows an
 * animated shimmer (like Codex/ChatGPT). No more long request → no
 * proxy timeout. The result is persisted as a cloud artifact (surfaceMarkup).
 *
 * In-memory map: `next start` is ONE process → the map survives across requests
 * (generate-start + status-poll share it). On a server restart in-flight
 * jobs are lost (rare, acceptable). N11: the image engine has its
 * own single-flight (ImageGenBusyError) → max one heavy run at a time.
 */

import { readFile } from 'node:fs/promises';

import {
  generateImageViaCodex,
  ImageGenBusyError,
  NoImageProducedError,
} from './codex-mcp';

export type ImageJobStatus = 'generating' | 'done' | 'error';

export interface ImageJob {
  id: string;
  status: ImageJobStatus;
  prompt: string;
  workspace: string;
  startedAt: number;
  finishedAt?: number;
  /** On done: cloud-artifact data. */
  artifactId?: string;
  imageUrl?: string;
  surfaceMarkup?: string;
  /** On error: code + message. */
  errorCode?: 'busy' | 'no-image' | 'failed';
  error?: string;
}

const JOBS = new Map<string, ImageJob>();
const MAX_JOBS = 200;

function evictIfNeeded(): void {
  if (JOBS.size <= MAX_JOBS) return;
  // Remove the oldest (by startedAt).
  const sorted = [...JOBS.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const j of sorted.slice(0, JOBS.size - MAX_JOBS)) JOBS.delete(j.id);
}

/** Unique, sortable job ID without the Date.now-in-renderer problem (server-side ok). */
function newJobId(): string {
  return `IMG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Starts an image job in the background and returns the jobId IMMEDIATELY.
 * The actual (slow) run + upload happens fire-and-forget.
 */
export function startImageJob(input: {
  workspace: string;
  prompt: string;
  actor: string;
}): ImageJob {
  const job: ImageJob = {
    id: newJobId(),
    status: 'generating',
    prompt: input.prompt,
    workspace: input.workspace,
    startedAt: Date.now(),
  };
  JOBS.set(job.id, job);
  evictIfNeeded();

  void (async () => {
    try {
      const result = await generateImageViaCodex({ prompt: input.prompt });
      const data = await readFile(result.pngPath);
      const { uploadArtifact } = await import('@/lib/cloud/service');
      const slug =
        input.prompt
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^[-.]+|[-.]+$/g, '')
          .slice(0, 48) || 'bild';
      const row = await uploadArtifact({
        workspaceId: input.workspace,
        filename: `${slug}.png`,
        mime: 'image/png',
        data,
        folderId: null,
        createdBy: input.actor,
        metadata: { generated: true, generatorType: 'codex-imagegen', sourcePrompt: input.prompt },
      });
      const surfacePayload = {
        id: row.id,
        filename: row.filename,
        mime: row.mime,
        bytes: row.bytes,
        workspace: row.workspaceId,
        downloadUrl: `/api/cloud/${row.id}`,
        previewUrl: `/api/cloud/${row.id}/preview`,
        thumbnailUrl: `/api/cloud/${row.id}/thumb`,
      };
      const done: ImageJob = {
        ...job,
        status: 'done',
        finishedAt: Date.now(),
        artifactId: row.id,
        imageUrl: surfacePayload.previewUrl,
        surfaceMarkup: `<surface:document>${JSON.stringify(surfacePayload)}</surface:document>`,
      };
      JOBS.set(job.id, done);
    } catch (err) {
      const isBusy = err instanceof ImageGenBusyError;
      const isNoImage = err instanceof NoImageProducedError;
      JOBS.set(job.id, {
        ...job,
        status: 'error',
        finishedAt: Date.now(),
        errorCode: isBusy ? 'busy' : isNoImage ? 'no-image' : 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return job;
}

export function getImageJob(jobId: string): ImageJob | null {
  return JOBS.get(jobId) ?? null;
}
