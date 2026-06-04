/**
 * Hook for chat inline file upload.
 *
 * Uploads a list of files to `/api/cloud` (multipart) and returns, per
 * successful upload, a `<surface:document>` surface markup line that the
 * caller can insert into its history.
 *
 * Errors are collected; the caller decides what happens with them
 * (toast, inline error item, etc.).
 */

'use client';

import { useCallback, useState } from 'react';

export interface UploadedArtifact {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  pages: number | null;
  workspaceId: string;
  workspaceLabel?: string;
  downloadUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
  /** Relative storage key (`<ws>/ART-id`). */
  storagePath?: string;
  /**
   * Absolute disk path — for the agent prompt (`[Angehängt: <abs-pfad>]`).
   * Null for encrypted artifacts / S3 backend.
   */
  absPath?: string | null;
}

export interface UploadFailure {
  filename: string;
  error: string;
  status: number;
}

export interface UseChatCloudUploadResult {
  uploading: boolean;
  /** Active filename during upload — for inline status. */
  currentFilename: string | null;
  upload: (
    files: File[],
    opts: { workspaceId: string; workspaceLabel?: string },
  ) => Promise<{ ok: UploadedArtifact[]; fail: UploadFailure[] }>;
}

export function useChatCloudUpload(): UseChatCloudUploadResult {
  const [uploading, setUploading] = useState(false);
  const [currentFilename, setCurrentFilename] = useState<string | null>(null);

  const upload = useCallback<UseChatCloudUploadResult['upload']>(
    async (files, opts) => {
      const ok: UploadedArtifact[] = [];
      const fail: UploadFailure[] = [];
      setUploading(true);
      try {
        for (const file of files) {
          setCurrentFilename(file.name);
          const fd = new FormData();
          fd.append('workspace', opts.workspaceId);
          fd.append('file', file);
          let res: Response;
          try {
            res = await fetch('/api/cloud', {
              method: 'POST',
              body: fd,
              credentials: 'same-origin',
            });
          } catch (err) {
            fail.push({
              filename: file.name,
              error: err instanceof Error ? err.message : 'network',
              status: 0,
            });
            continue;
          }
          if (!res.ok) {
            let message = `HTTP ${res.status}`;
            try {
              const j = await res.json();
              if (typeof j?.message === 'string') message = j.message;
              else if (typeof j?.error === 'string') message = j.error;
            } catch {
              /* ignore */
            }
            fail.push({ filename: file.name, error: message, status: res.status });
            continue;
          }
          try {
            const j = await res.json();
            const a = j?.artifact;
            if (a && typeof a.id === 'string') {
              ok.push({
                id: a.id,
                filename: a.filename,
                mime: a.mime,
                bytes: a.bytes,
                pages: a.pages ?? null,
                workspaceId: opts.workspaceId,
                workspaceLabel: opts.workspaceLabel,
                downloadUrl: a.downloadUrl ?? `/api/cloud/${a.id}`,
                previewUrl: a.previewUrl ?? `/api/cloud/${a.id}/preview`,
                thumbnailUrl: a.thumbnailUrl ?? `/api/cloud/${a.id}/thumb`,
                storagePath: typeof a.storagePath === 'string' ? a.storagePath : undefined,
                absPath: typeof a.absPath === 'string' ? a.absPath : null,
              });
            }
          } catch (err) {
            fail.push({
              filename: file.name,
              error: err instanceof Error ? err.message : 'parse-fail',
              status: res.status,
            });
          }
        }
      } finally {
        setUploading(false);
        setCurrentFilename(null);
      }
      return { ok, fail };
    },
    [],
  );

  return { uploading, currentFilename, upload };
}

/**
 * Builds a `<surface:document>` markup string for the chat history.
 * The surface parser in the chat recognizes it and renders the card.
 */
export function buildDocumentSurfaceMarkup(a: UploadedArtifact): string {
  const payload = {
    id: a.id,
    filename: a.filename,
    mime: a.mime,
    bytes: a.bytes,
    pages: a.pages,
    workspace: a.workspaceId,
    workspaceLabel: a.workspaceLabel,
    downloadUrl: a.downloadUrl,
    previewUrl: a.previewUrl,
    thumbnailUrl: a.thumbnailUrl,
  };
  return `<surface:document>${JSON.stringify(payload)}</surface:document>`;
}
