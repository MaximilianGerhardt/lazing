/**
 * markdown-mini — lean Markdown renderer for chat bubbles + TicketThread.
 *
 * Deliberately NO 'use client': the function is pure logic without state/hooks
 * and can be used both in the server-component render (TicketThread from the
 * RSC detail page) and in the client-component render (ChatShell).
 *
 * Instead of react-markdown (~30KB bundle), a tailored subset parser:
 * - `# H1` / `## H2` / `### H3` (line prefix)
 * - `- item` / `* item` / `1. item` lists (block, multi-line)
 * - ``` ```code-block``` ``` (multi-line, mono font, scroll-x)
 * - `inline code` inline mono with a subtle background
 * - `**bold**`, `*italic*`
 * - plain text with \n as <br>
 *
 * Style guideline: Apple-Keynote like /design — light typography, clear
 * hierarchy, mono only for code, generous whitespace between blocks.
 *
 * Deliberately NOT supported: links (security), images, tables, HTML.
 * Sufficient for chat answers from Claude.
 */

import type { CSSProperties, ReactNode } from 'react';

import { CodeBlock } from './CodeBlock';

type Block =
  | { kind: 'h1' | 'h2' | 'h3'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; lang?: string; content: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' };

/** Splits a GFM table row `| a | b |` into trimmed cells. */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** Separator row of a GFM table? e.g. `| --- | :--: |` */
function isTableSeparator(line: string): boolean {
  const s = line.trim();
  if (!s.includes('-') || !s.includes('|')) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(s);
}

/**
 * Block parser. Splits a complete Markdown string into blocks.
 * Code fences (```...```) are atomic — everything between is taken verbatim
 * as a 'code' block, no inline processing.
 */
function parseBlocks(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    const fenceMatch = /^```(\w+)?\s*$/.exec(line);
    if (fenceMatch) {
      const lang = fenceMatch[1];
      const content: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        content.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ kind: 'code', lang, content: content.join('\n') });
      continue;
    }

    // Heading
    const hMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (hMatch) {
      const level = hMatch[1].length as 1 | 2 | 3;
      blocks.push({ kind: `h${level}` as 'h1' | 'h2' | 'h3', text: hMatch[2] });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^[-_*]{3,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // GFM table: header row (contains `|`) directly followed by a
    // separator row (`| --- | :--: |`). Codex parity (2026-06-02): previously
    // `| a | b |` rows fell into the paragraph path → raw pipes in the feed.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1])
    ) {
      const header = splitTableRow(line);
      i += 2; // consume header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+\S/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+\S/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+\S/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+\S/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // Empty → consume
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: collect everything up to the next blank line / block marker
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i]) &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^[-_*]{3,}\s*$/.test(lines[i]) &&
      // do not swallow a directly following table (row + separator) into the
      // paragraph
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', text: paraLines.join('\n') });
  }

  return blocks;
}

/**
 * Feed cleanliness (Apple pass 2026-05-30): defensive masking filter against raw
 * machine IDs/URLs in the visible bubble text. Applies ONLY to plain text
 * (not in code blocks, not in a link's `href`) — the system-recovery cards
 * ("run … interrupted") otherwise leaked `__org_root__`, `WS-XXXX`,
 * `action=resume` + raw `http(s)://…?query` strings as visible text.
 *
 * Rules (conservative, deterministic):
 *   - raw `http(s)://…` URL with a query string → removed (the link affordance
 *     lives in the rendered `[label](href)`, not in the bare URL text).
 *   - raw relative resume query (`/?…action=resume…` or `?…action=resume`) → removed.
 *   - `__org_root__` sentinel → removed.
 *   - `WS-[A-Z0-9]{6,}` machine ID → masked to "diesem Lauf".
 *   - `&ws=…` / `&workspace=…` / `action=resume` fragments → removed.
 * Multiple spaces are then collapsed.
 */
const RAW_URL_QUERY_RE = /https?:\/\/[^\s)]+\?[^\s)]+/gi;
const REL_RESUME_QUERY_RE = /\/?\?[^\s)]*action=resume[^\s)]*/gi;
const ORG_ROOT_RE = /__org_root__/g;
const WS_ID_RE = /\bWS-[A-Z0-9]{6,}\b/g;
const QUERY_FRAGMENT_RE = /[?&](?:ws|workspace)=[^\s&)]*/gi;
const ACTION_RESUME_RE = /\baction=resume\b/gi;

/**
 * Feed cleanliness (Apple pass 2026-05-30, render-robustness critic HIGH):
 * raw HTML-in-Markdown leaked as visible text in history bubbles —
 * `<address>`, `<ul>`/`<li>`, `<div>` etc. appeared as bare `<tag>` strings
 * (the mini parser knows NO HTML, so the tags fell into the paragraph path
 * and `renderInline` pushed them raw into a <span>; React escaped them →
 * visible `<address>` text). Apple never shows raw tags.
 *
 * Fix: HTML tag MARKERS (opening/closing/self-closing) are removed from plain
 * text, the CONTENT between them is preserved (no data loss:
 * `<address>Foo</address>` → "Foo"). Block-like tags (`<br>`, `<p>`, `<li>`,
 * `<div>`, …) leave a line break so the text rhythm does not collapse.
 * HTML comments/`<!doctype>`/script-style contents are discarded entirely
 * (no XSS, no raw tag).
 *
 * Conservative: applies ONLY to genuine HTML tag forms
 * (`</?[a-zA-Z][\w-]*…>`). Mathematical/prose comparisons like `a < b`, `x > 3`
 * or `5 <= n` stay untouched because no tag-name start follows the `<`.
 */
// Discard script/style blocks including their content (defense-in-depth against
// XSS attempts that could slip through as raw Markdown text).
const HTML_DANGEROUS_BLOCK_RE =
  /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Remove HTML comments + `<!doctype …>` / `<![CDATA[ … ]]>` entirely.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HTML_DECL_RE = /<![^>]*>/g;
// Block-like tags → newline (so paragraph/list rhythm is preserved).
const HTML_BLOCK_TAG_RE =
  /<\/?(?:address|article|aside|blockquote|br|div|dd|dl|dt|figure|footer|h[1-6]|header|hr|li|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi;
// All other HTML tags (inline like <span>, <b>, <a …>) → remove, content stays.
const HTML_ANY_TAG_RE = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*?)?\/?>/g;

/**
 * Neutralizes raw HTML tags in plain bubble text. No raw `<tag>` string
 * may reach the feed; the visible CONTENT is preserved.
 */
export function neutralizeHtmlTags(text: string): string {
  if (text.indexOf('<') === -1) return text; // fast path: no tag possible
  const out = text
    .replace(HTML_DANGEROUS_BLOCK_RE, '')
    .replace(HTML_COMMENT_RE, '')
    .replace(HTML_DECL_RE, '')
    .replace(HTML_BLOCK_TAG_RE, '\n')
    .replace(HTML_ANY_TAG_RE, '');
  // Block tags → `\n`: an enclosing `<address>…</address>` would otherwise
  // leave a leading + trailing blank break each (visible
  // <br/> edge in the bubble). Collapse multiple newlines, trim edges —
  // but ONLY if a tag was actually replaced (out ≠ text), so plain
  // text with intentional blank lines stays untouched.
  if (out === text) return out;
  return out.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
}

export function sanitizeBubbleText(text: string): string {
  if (text.indexOf('http') === -1 &&
      text.indexOf('__org_root__') === -1 &&
      text.indexOf('WS-') === -1 &&
      text.indexOf('action=resume') === -1 &&
      text.indexOf('?ws=') === -1 &&
      text.indexOf('&ws=') === -1 &&
      text.indexOf('<') === -1) {
    return text; // fast path: nothing to mask
  }
  let out = neutralizeHtmlTags(text)
    .replace(RAW_URL_QUERY_RE, '')
    .replace(REL_RESUME_QUERY_RE, '')
    .replace(QUERY_FRAGMENT_RE, '')
    .replace(ACTION_RESUME_RE, '')
    .replace(ORG_ROOT_RE, '')
    .replace(WS_ID_RE, 'diesem Lauf');
  // Collapse double spaces / empty parens, clean up trailing separators.
  out = out
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1');
  return out;
}

/**
 * Inline renderer. Processes `[label](href)` (ONLY same-origin), `**bold**`,
 * `*italic*` and `` `code` `` in a single pipeline. Token-based with a
 * stack so overlapping markers are handled conservatively.
 *
 * Links: same-origin relative hrefs (start with `/`) are rendered as a
 * clickable pill — the URL lives in the `href`, only the label is visible
 * (Apple feed cleanliness: no raw query in the text). External `http(s)`
 * hrefs have been rendered as a clickable link with
 * `target="_blank" rel="noopener noreferrer nofollow"` since 2026-06-02 (Codex
 * parity). Other schemes (`javascript:`, `data:`, …) stay plain label (no link).
 */
function renderInline(text: string, baseKey: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let segIdx = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    // Defensive masking filter BEFORE rendering (feed cleanliness).
    const safe = sanitizeBubbleText(buf);
    // Render newlines in the paragraph as <br> so multi-line is kept
    const parts = safe.split('\n');
    parts.forEach((p, pi) => {
      if (pi > 0) out.push(<br key={`${baseKey}-br-${segIdx++}`} />);
      if (p.length > 0) {
        out.push(<span key={`${baseKey}-t-${segIdx++}`}>{p}</span>);
      }
    });
    buf = '';
  };

  while (i < text.length) {
    const ch = text[i];
    // Link [label](href) — ONLY same-origin (href starts with '/').
    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close > i && text[close + 1] === '(') {
        const hrefEnd = text.indexOf(')', close + 2);
        if (hrefEnd > close) {
          const label = text.slice(i + 1, close);
          const href = text.slice(close + 2, hrefEnd).trim();
          flush();
          if (href.startsWith('/')) {
            // same-origin → clickable pill; URL only in href, label visible.
            out.push(
              <a
                key={`${baseKey}-lnk-${segIdx++}`}
                href={href}
                style={linkStyle}
                data-test="md-inline-link"
              >
                {sanitizeBubbleText(label)}
              </a>,
            );
          } else if (/^https?:\/\//i.test(href)) {
            // Codex parity (2026-06-02): make external http(s) links clickable.
            // Safe via `rel="noopener noreferrer nofollow"` + `target="_blank"`
            // (no tab-nabbing, no referrer leak, no SEO juice); the URL
            // lives only in the href. `javascript:`/`data:`/other schemes fall
            // through to the text path below (no link → no XSS surface).
            out.push(
              <a
                key={`${baseKey}-extlnk-${segIdx++}`}
                href={href}
                style={linkStyle}
                target="_blank"
                rel="noopener noreferrer nofollow"
                data-test="md-inline-link-ext"
              >
                {sanitizeBubbleText(label)}
              </a>,
            );
          } else {
            // Unsafe href (javascript:, data:, …) → only label as text.
            out.push(
              <span key={`${baseKey}-lnktxt-${segIdx++}`}>
                {sanitizeBubbleText(label)}
              </span>,
            );
          }
          i = hrefEnd + 1;
          continue;
        }
      }
    }
    // Inline code
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push(
          <code key={`${baseKey}-code-${segIdx++}`} style={inlineCodeStyle}>
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    // Bold **...**
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end > i + 1) {
        flush();
        out.push(
          <strong key={`${baseKey}-b-${segIdx++}`} style={boldStyle}>
            {text.slice(i + 2, end)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }
    // Italic *...*  (single, ONLY if not directly surrounded by **)
    if (ch === '*' && text[i - 1] !== '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end > i && text[end + 1] !== '*') {
        flush();
        out.push(
          <em key={`${baseKey}-i-${segIdx++}`}>{text.slice(i + 1, end)}</em>,
        );
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function renderMarkdown(md: string, keyBase = 'md'): ReactNode {
  const blocks = parseBlocks(md);
  // `md-prose` (Apple pass 2026-05-30, critic MEDIUM): carries the prose
  // readability rules (limited line length ~62ch, vertical paragraph rhythm)
  // in app/components.css — token-only, no hex. Surfaces are SIBLINGS of this
  // wrapper (not inside it) and therefore stay full-width + stand out.
  return (
    <div className="md-prose" style={wrapStyle} data-test="md-prose">
      {blocks.map((b, i) => renderBlock(b, `${keyBase}-${i}`))}
    </div>
  );
}

function renderBlock(b: Block, key: string): ReactNode {
  switch (b.kind) {
    case 'h1':
      return (
        <h3 key={key} style={h1Style}>
          {renderInline(b.text, `${key}-h`)}
        </h3>
      );
    case 'h2':
      return (
        <h4 key={key} style={h2Style}>
          {renderInline(b.text, `${key}-h`)}
        </h4>
      );
    case 'h3':
      return (
        <h5 key={key} style={h3Style}>
          {renderInline(b.text, `${key}-h`)}
        </h5>
      );
    case 'p':
      return (
        <p key={key} style={paragraphStyle}>
          {renderInline(b.text, `${key}-p`)}
        </p>
      );
    case 'ul':
      return (
        <ul key={key} style={listStyle}>
          {b.items.map((it, j) => (
            <li key={`${key}-li-${j}`} style={listItemStyle}>
              {renderInline(it, `${key}-li-${j}`)}
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} style={listStyle}>
          {b.items.map((it, j) => (
            <li key={`${key}-li-${j}`} style={listItemStyle}>
              {renderInline(it, `${key}-li-${j}`)}
            </li>
          ))}
        </ol>
      );
    case 'code': {
      // Codex parity (goal 2026-06-02): ALWAYS render code inline — framed
      // block with language + copy button, no more "details" collapse. The
      // earlier disclosure (schema/JSON or > 6 lines collapsed) made every
      // code answer look like a hidden attachment instead of like in Codex.
      return <CodeBlock key={key} lang={b.lang} content={b.content} />;
    }
    case 'table': {
      return (
        <div key={key} style={tableWrapStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                {b.header.map((cell, j) => (
                  <th key={`${key}-th-${j}`} style={thStyle}>
                    {renderInline(cell, `${key}-th-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={`${key}-tr-${r}`}>
                  {b.header.map((_, c) => (
                    <td key={`${key}-td-${r}-${c}`} style={tdStyle}>
                      {renderInline(row[c] ?? '', `${key}-td-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'hr':
      return <hr key={key} style={hrStyle} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Styles — Apple-Keynote / Rams style for chat. Tighter than /design because
// the chat bubble is naturally smaller, but the same language.
// ---------------------------------------------------------------------------

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const h1Style: CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: 'var(--ink)',
  margin: 0,
  marginTop: 4,
};

const h2Style: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: '-0.015em',
  color: 'var(--ink)',
  margin: 0,
};

const h3Style: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-2)',
  margin: 0,
};

const paragraphStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.55,
  letterSpacing: '-0.005em',
  color: 'var(--ink)',
};

const boldStyle: CSSProperties = {
  // Codex parity (goal 2026-06-02): bold is weight, not color. Previously
  // `var(--a-now)` → every `**bold**` term was colored in the segment accent
  // (cyan), so body text looked like a link desert. Codex renders bold
  // as strong white — same ink, more weight.
  fontWeight: 650,
  color: 'var(--ink)',
};

const listStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const listItemStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const linkStyle: CSSProperties = {
  color: 'var(--a-now)',
  textDecoration: 'none',
  fontWeight: 500,
  borderBottom: '0.5px solid color-mix(in oklab, var(--a-now) 40%, transparent)',
  cursor: 'pointer',
};

const inlineCodeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '1px 6px',
  borderRadius: 4,
  background: 'color-mix(in oklab, var(--ink) 8%, transparent)',
  color: 'var(--ink)',
};

const hrStyle: CSSProperties = {
  border: 'none',
  borderTop: '0.5px solid var(--line-2)',
  margin: '4px 0',
};

// Codex parity (2026-06-02): clear, framed table. Horizontal scroll on a
// narrow viewport (mobile), subtle token lines instead of heavy borders.
const tableWrapStyle: CSSProperties = {
  margin: 0,
  overflowX: 'auto',
  border: '0.5px solid var(--line-2)',
  borderRadius: 10,
};

const tableStyle: CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
  fontSize: 13,
  lineHeight: 1.45,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--ink)',
  padding: '8px 12px',
  borderBottom: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--ink) 4%, transparent)',
  whiteSpace: 'nowrap',
};

const tdStyle: CSSProperties = {
  textAlign: 'left',
  color: 'var(--ink)',
  padding: '7px 12px',
  borderBottom: '0.5px solid color-mix(in oklab, var(--line-2) 60%, transparent)',
  verticalAlign: 'top',
};
