'use client';

/**
 * CodeBlock — Codex-artiger Inline-Code-Block für Chat-Antworten.
 *
 * Ziel (Goal 2026-06-02): „UI/UX kaum von Codex unterscheidbar". Codex zeigt
 * Code IMMER inline — gerahmter Container, schmale Kopfzeile mit Sprache links
 * + Copy-Button rechts, darunter der Code mit Mono-Font und horizontalem Scroll.
 * Es versteckt Code NICHT hinter einer „Details"-Disclosure.
 *
 * Ersetzt die frühere `<details>`-Kollaps-Logik in markdown-mini (Schema/JSON
 * oder > 6 Zeilen wurden zugeklappt — das ließ jede Code-Antwort wie einen
 * eingeklappten Anhang wirken statt wie ein Coding-Assistent).
 *
 * Eigenes `'use client'`-Modul, damit `renderMarkdown` (das auch in
 * Server-Components wie TicketThread läuft) eine Client-Insel einbettet, ohne
 * selbst zur Client-Komponente zu werden. Sehr lange Blöcke bekommen eine
 * max-height mit innerem Scroll (wie Codex), bleiben aber default offen.
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
      /* clipboard kann in unsicheren Kontexten fehlen — still ignorieren */
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
