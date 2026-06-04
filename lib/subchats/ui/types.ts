/**
 * Shared UI types for the sub-chat messenger views (external + internal).
 * Gathering-Intelligence goal (2026-06-02).
 */

export interface UiAttachment {
  artifactId: string;
  filename: string;
  mime: string;
  bytes: number;
  kind: 'image' | 'file' | 'audio';
}

export interface UiMessage {
  id: string;
  authorKind: 'internal' | 'external' | 'system';
  authorName: string | null;
  content: string;
  attachments?: UiAttachment[];
  createdAt: number;
}

/** How a media URL for an attachment is built (transport-specific). */
export type MediaUrlFn = (a: UiAttachment, variant: 'inline' | 'download') => string;
