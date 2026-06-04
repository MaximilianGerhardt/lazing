import type { TermLine, TermLineLevel, TermSpan } from './types';

interface TerminalProps {
  /**
   * Ordered list of terminal lines, oldest first.
   * Append-only — the component does not mutate or sort.
   */
  lines: TermLine[];
  className?: string;
}

/**
 * Maps a `TermLineLevel` to its corresponding CSS class in
 * `app/components.css` (section J · TRM). The `default`
 * level produces no class so the span inherits the base
 * terminal text colour.
 */
function levelClass(level: TermLineLevel | undefined): string | undefined {
  switch (level) {
    case 'prompt':
      return 'p';
    case 'host':
      return 'h';
    case 'dim':
      return 'o';
    case 'error':
      return 'e';
    case 'ok':
      return 'ok';
    case 'claude':
      return 'cl';
    case 'codex':
      return 'cx';
    case 'default':
    case undefined:
    default:
      return undefined;
  }
}

/**
 * Renders a single span. If no level is set we emit the raw
 * text (no wrapper) so the line reads naturally in the
 * flattened DOM — matches the HTML reference exactly.
 */
function renderSpan(span: TermSpan, idx: number) {
  const cls = levelClass(span.level);
  if (!cls) return <span key={idx}>{span.text}</span>;
  return (
    <span key={idx} className={cls}>
      {span.text}
    </span>
  );
}

/**
 * TRM-01 — Terminal Block.
 *
 * Renders a monospace terminal-style output with colour-
 * tagged spans. Fully SSR-safe — no client state, no refs,
 * no `Math.random`.
 *
 * Accessibility:
 * - `role="log"` + `aria-live="polite"` lets screen readers
 *   announce newly appended lines without stealing focus.
 * - `aria-relevant="additions"` keeps announcements scoped
 *   to the new content (not the full history replay).
 *
 * Monospace font, line-height and colours are provided by
 * `.term` / `.term .ln` in `app/components.css`.
 *
 * Cursor handling:
 * - Set `cursor: true` on the final "live prompt" line to
 *   append a blinking caret (`<span class="cu">`). The CSS
 *   drives the animation; no JS interval required.
 */
export function Terminal({ lines, className }: TerminalProps) {
  const cls = className ? `term ${className}` : 'term';

  return (
    <div
      className={cls}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Terminal output"
    >
      {lines.map((line, i) => {
        const spans: TermSpan[] =
          line.spans && line.spans.length > 0
            ? line.spans
            : line.text !== undefined
              ? [{ text: line.text, level: line.level }]
              : [];

        return (
          <span key={i} className="ln">
            {spans.map(renderSpan)}
            {line.cursor ? <span className="cu" aria-hidden="true" /> : null}
          </span>
        );
      })}
    </div>
  );
}
