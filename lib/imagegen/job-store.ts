/**
 * lib/imagegen/job-store.ts — asynchroner Bild-Generierungs-Job (2026-06-03).
 *
 * Owner-Befund: das synchrone /api/imagegen/generate blockierte ~30–90 s →
 * lief durch den cloudflared-Proxy in einen Timeout („Fehler, kein Bild") und
 * zeigte nur statischen Toast-Text statt eines animierten Lade-Surfaces.
 *
 * Lösung: der Job läuft im HINTERGRUND. `startImageJob` liefert sofort eine
 * jobId; das Surface (ImageGenCard) pollt `getJob` und zeigt währenddessen einen
 * animierten Shimmer (wie Codex/ChatGPT). Kein Long-Request mehr → kein
 * Proxy-Timeout. Ergebnis wird als Cloud-Artifact persistiert (surfaceMarkup).
 *
 * In-Memory-Map: `next start` ist EIN Prozess → die Map überlebt über Requests
 * (generate-start + status-poll teilen sie). Bei Server-Neustart gehen
 * in-flight-Jobs verloren (selten, akzeptabel). N11: die Bild-Engine hat ihr
 * eigenes Single-Flight (ImageGenBusyError) → max ein schwerer Lauf gleichzeitig.
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
  /** Bei done: Cloud-Artifact-Daten. */
  artifactId?: string;
  imageUrl?: string;
  surfaceMarkup?: string;
  /** Bei error: Code + Nachricht. */
  errorCode?: 'busy' | 'no-image' | 'failed';
  error?: string;
}

const JOBS = new Map<string, ImageJob>();
const MAX_JOBS = 200;

function evictIfNeeded(): void {
  if (JOBS.size <= MAX_JOBS) return;
  // Älteste (nach startedAt) entfernen.
  const sorted = [...JOBS.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const j of sorted.slice(0, JOBS.size - MAX_JOBS)) JOBS.delete(j.id);
}

/** Eindeutige, sortierbare Job-ID ohne Date.now-im-Renderer-Problem (Server-Seite ok). */
function newJobId(): string {
  return `IMG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Startet einen Bild-Job im Hintergrund und gibt SOFORT die jobId zurück.
 * Der eigentliche (langsame) Lauf + Upload passiert fire-and-forget.
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
