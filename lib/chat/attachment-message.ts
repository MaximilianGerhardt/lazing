/**
 * Attachment-Message-Builder (Staging-Modell · 2026-05-26).
 * ---------------------------------------------------------
 * Owner hard requirement: a selected file is NOT sent immediately.
 * It sits as a fixed preview ABOVE the composer (WhatsApp/Telegram style).
 * The user can additionally type text (caption/instruction). On send,
 * file(s) + text go out TOGETHER in the same message:
 *   - the user bubble shows the attachment(s) on top + the caption below,
 *   - the prompt sent to the agent contains BOTH: the file paths
 *     (`[Angehängt: <abs-pfad>]`) AND the user text.
 *
 * This file is pure logic (no React/DOM) → unit-testable.
 */

import type { UploadedArtifact } from './useChatCloudUpload';

/** A file staged in the composer (already uploaded). */
export type StagedAttachment = UploadedArtifact;

/**
 * `<surface:document>` markup for ONE staged file. Identical to the
 * format that `buildDocumentSurfaceMarkup` produces — the bubble renders
 * the document card from it (image bubble / file card).
 */
export function attachmentSurfaceMarkup(a: StagedAttachment): string {
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

/**
 * Content of the sent user BUBBLE: attachments on top (one document card each),
 * caption (user text) below. This gives the user exactly the WhatsApp/
 * Telegram layout: image/file on top, text below.
 *
 * `caption` may be empty (attachment only, no text).
 */
export function buildBubbleContent(
  attachments: readonly StagedAttachment[],
  caption: string,
): string {
  const cards = attachments.map(attachmentSurfaceMarkup).join('\n');
  const cap = caption.trim();
  if (cards.length === 0) return cap;
  return cap.length > 0 ? `${cards}\n\n${cap}` : cards;
}

/**
 * Best path reference for the agent: absolute disk path if present
 * (Read/vision-capable), otherwise the download URL as a fallback (e.g. encrypted
 * / S3). Never empty.
 */
export function agentPathRef(a: StagedAttachment): string {
  if (typeof a.absPath === 'string' && a.absPath.length > 0) return a.absPath;
  if (typeof a.storagePath === 'string' && a.storagePath.length > 0) {
    return a.storagePath;
  }
  return a.downloadUrl;
}

/**
 * Prompt text that goes to the AGENT: file references as header lines
 * (`[Angehängt: <name> — <pfad>]`) FOLLOWED by a blank line and the
 * user text. This way the agent sees both in ONE turn.
 *
 * If no attachments: identical to the plain user text.
 * If only attachments (no text): a neutral default hint, so the
 * turn is not empty and the agent knows a file was sent.
 */
export function buildAgentPrompt(
  attachments: readonly StagedAttachment[],
  userText: string,
): string {
  const text = userText.trim();
  if (attachments.length === 0) return text;

  const lines = attachments.map((a) => {
    const kind = a.mime.startsWith('image/') ? 'Bild' : 'Datei';
    return `[Angehängt: ${kind} "${a.filename}" (${a.mime}) — ${agentPathRef(a)}]`;
  });
  const header = lines.join('\n');

  if (text.length === 0) {
    // No caption text → a clear default instruction so the agent reacts.
    return `${header}\n\nIch habe ${attachments.length === 1 ? 'eine Datei' : `${attachments.length} Dateien`} angehängt. Bitte sieh sie dir an.`;
  }
  return `${header}\n\n${text}`;
}

/**
 * Allowed to send? Yes, as soon as there is text OR at least one attachment.
 * (An attachment alone without text is allowed — WhatsApp behavior.)
 */
export function canSendWithAttachments(
  attachments: readonly StagedAttachment[],
  userText: string,
): boolean {
  return attachments.length > 0 || userText.trim().length > 0;
}
