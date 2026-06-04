'use client';

/**
 * CodeBlock — a Codex-style inline code block for chat answers.
 *
 * Goal (2026-06-02): „UI/UX kaum von Codex unterscheidbar". Codex shows
 * code ALWAYS inline — a framed container, a slim header with the language on the left
 * + a copy button on the right, below it the code with a mono font and horizontal scroll.
 * It does NOT hide code behind a „Details" disclosure.
 *
 * Replaces the earlier `<details>` collapse logic in markdown-mini (schema/JSON
 * or > 6 lines were collapsed — which made every code answer look like a
 * collapsed attachment instead of a coding assistant).
 *
 * Its own `'use client'` module so `renderMarkdown` (which also runs in
 * server components like TicketThread) embeds a client island without
 * becoming a client component itself. Very long blocks get a
 * max-height with inner scroll (like Codex), but stay open by default.
 */

import { useCallback, useState, type CSSProperties, type ReactElement } from 'react';

export interface CodeBlockProps {
  content: string;
  lang?: string;
}

export function CodeBlock({ content, lang }: CodeBlockProps): ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard can be missing in insecure contexts — ignore silently */
    }
  }, [content]);

  return (
    <div style={wrapStyle} data-test="md-code-block">
      <div style={headerStyle}>
        <span style={langStyle}>{lang || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          style={copyBtnStyle}
          aria-label={copied ? 'Kopiert' : 'Code kopieren'}
        >
          {copied ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
      <pre style={preStyle}>
        <code>{content}</code>
      </pre>
    </div>
  );
}

const wrapStyle: CSSProperties = {
  margin: 0,
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-3)',
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '5px 10px 5px 12px',
  borderBottom: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--ink) 4%, transparent)',
};

const langStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const copyBtnStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--ink-2)',
  padding: '2px 4px',
  borderRadius: 4,
};

const preStyle: CSSProperties = {
  margin: 0,
  padding: '12px 14px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  lineHeight: 1.55,
  color: 'var(--ink)',
  overflowX: 'auto',
  maxHeight: 420,
  overflowY: 'auto',
  whiteSpace: 'pre',
};

export default CodeBlock;
