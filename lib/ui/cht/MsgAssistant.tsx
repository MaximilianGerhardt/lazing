import type { ReactNode } from 'react';

interface MsgAssistantProps {
  /**
   * Assistant content (gerendert via renderMarkdown / TextWithHighlights).
   * Bold wird seit 2026-06-02 (Codex-Parität) als `<strong>` in `var(--ink)`
   * gerendert — kräftiges Weiß, NICHT mehr im Segment-Akzent. Optional folgt
   * darunter eine dezente <MessageActions/>-Reihe (Copy / Neu generieren),
   * die per `.msg-a:hover` enthüllt wird.
   */
  children: ReactNode;
}

/**
 * CHT-01 — Assistant text bubble.
 *
 * Left-aligned card-colored bubble (via .msg-a / .txt in
 * app/components.css). Inhalt wird vom Markdown-Renderer gestylt; diese
 * Komponente plumbt nur den Bubble-Rahmen.
 */
export function MsgAssistant({ children }: MsgAssistantProps) {
  return (
    <div className="msg-a" role="article" aria-label="Assistant message">
      <div className="txt">{children}</div>
    </div>
  );
}
