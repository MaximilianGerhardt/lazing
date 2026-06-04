import type { ReactNode } from 'react';

interface MsgAssistantProps {
  /**
   * Assistant content (rendered via renderMarkdown / TextWithHighlights).
   * Since 2026-06-02 (Codex parity), bold is rendered as `<strong>` in `var(--ink)`
   * — strong white, NO longer in the segment accent. Optionally,
   * a subtle <MessageActions/> row (copy / regenerate) follows below it,
   * revealed via `.msg-a:hover`.
   */
  children: ReactNode;
}

/**
 * CHT-01 — Assistant text bubble.
 *
 * Left-aligned card-colored bubble (via .msg-a / .txt in
 * app/components.css). Content is styled by the markdown renderer; this
 * component only plumbs the bubble frame.
 */
export function MsgAssistant({ children }: MsgAssistantProps) {
  return (
    <div className="msg-a" role="article" aria-label="Assistant message">
      <div className="txt">{children}</div>
    </div>
  );
}
