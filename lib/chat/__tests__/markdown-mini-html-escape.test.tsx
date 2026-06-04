/**
 * markdown-mini — HTML-Tag-Entschärfung + Prosa-Lesbarkeit
 * (Apple-Pass 2026-05-30).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     lib/chat/__tests__/markdown-mini-html-escape.test.tsx
 *
 * Coverage:
 *   1. Render-Robustheit-Critic (HOCH): roher HTML-im-Markdown
 *      (`<address>`, `<ul>`/`<li>`, `<div>`) leakt NICHT mehr als nackter
 *      `<tag>`-String in den Feed — der INHALT bleibt sichtbar.
 *   2. Defense-in-Depth: `<script>`/`<style>` samt Inhalt + Inline-Event-
 *      Handler-Tags werden verworfen (kein XSS, kein roher Tag).
 *   3. Prosa-Vergleiche (`a < b`, `x > 3`) bleiben unangetastet (kein
 *      False-Positive der Tag-Erkennung).
 *   4. Prosa-Wrapper trägt die `md-prose`-Klasse (Träger der max-width-
 *      Lesbarkeitsregel in app/components.css).
 *
 * Pure-Logic + SSR via renderToStaticMarkup — keine Browser-DOM nötig.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  renderMarkdown,
  neutralizeHtmlTags,
  sanitizeBubbleText,
} from '../markdown-mini';

// renderToStaticMarkup escaped `<`/`>` zu `&lt;`/`&gt;`. Ein im Feed sichtbarer
// roher Tag würde also als `&lt;address&gt;` IM HTML auftauchen. Wir prüfen
// genau auf diese escapeten Tag-Marker.
function feedHtml(md: string): string {
  return renderToStaticMarkup(renderMarkdown(md));
}

describe('neutralizeHtmlTags — kein roher HTML-Tag im Feed', () => {
  it('entfernt <address>-Tag-Marker, behält den Inhalt', () => {
    const out = neutralizeHtmlTags('<address>Musterstr. 1, Berlin</address>');
    expect(out).not.toContain('<address>');
    expect(out).not.toContain('</address>');
    expect(out).toContain('Musterstr. 1, Berlin');
  });

  it('entfernt verschachtelte <ul>/<li>-Tags, behält Listentext', () => {
    const out = neutralizeHtmlTags('<ul><li>Eins</li><li>Zwei</li></ul>');
    expect(out).not.toContain('<ul>');
    expect(out).not.toContain('<li>');
    expect(out).toContain('Eins');
    expect(out).toContain('Zwei');
  });

  it('entfernt Inline-Tags (<div>, <span>, <a href>) ohne Inhaltsverlust', () => {
    const out = neutralizeHtmlTags(
      '<div>Hallo <span>Welt</span> <a href="/x">Link</a></div>',
    );
    expect(out).not.toMatch(/<\/?[a-z]/i);
    expect(out).toContain('Hallo');
    expect(out).toContain('Welt');
    expect(out).toContain('Link');
  });

  it('verwirft <script>-Block samt Inhalt (kein XSS)', () => {
    const out = neutralizeHtmlTags(
      'vorher<script>alert(1)</script>nachher',
    );
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('vorher');
    expect(out).toContain('nachher');
  });

  it('verwirft <style>-Block samt Inhalt', () => {
    const out = neutralizeHtmlTags('<style>.x{color:red}</style>Text');
    expect(out).not.toContain('<style>');
    expect(out).not.toContain('color:red');
    expect(out).toContain('Text');
  });

  it('entschärft self-closing + Event-Handler-Tag (img onerror)', () => {
    const out = neutralizeHtmlTags('<img src=x onerror="alert(1)" />');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror');
  });

  it('lässt Prosa-Vergleiche `a < b` / `x > 3` unangetastet', () => {
    expect(neutralizeHtmlTags('wenn a < b dann x > 3')).toBe(
      'wenn a < b dann x > 3',
    );
    expect(neutralizeHtmlTags('5 <= n und n >= 0')).toBe('5 <= n und n >= 0');
  });

  it('schneller Pfad: Text ohne `<` unverändert', () => {
    expect(neutralizeHtmlTags('nur reiner Text')).toBe('nur reiner Text');
  });
});

describe('sanitizeBubbleText — HTML-Entschärfung ist verdrahtet', () => {
  it('entschärft Tags auch über den sanitize-Pfad', () => {
    const out = sanitizeBubbleText('<ul><li>A</li></ul>');
    expect(out).not.toContain('<ul>');
    expect(out).not.toContain('<li>');
    expect(out).toContain('A');
  });
});

describe('renderMarkdown — kein roher Tag erreicht den Feed (SSR)', () => {
  it('zeigt KEIN escapetes <address> im HTML, aber den Inhalt', () => {
    const html = feedHtml('Kontakt:\n\n<address>Musterstr. 1</address>');
    // Kein roher Tag-Marker (escaped) im Feed:
    expect(html).not.toContain('&lt;address&gt;');
    expect(html).not.toContain('&lt;/address&gt;');
    // Inhalt überlebt:
    expect(html).toContain('Musterstr. 1');
  });

  it('zeigt KEINE escapeten <ul>/<li> im HTML', () => {
    const html = feedHtml('<ul><li>Punkt A</li><li>Punkt B</li></ul>');
    expect(html).not.toContain('&lt;ul&gt;');
    expect(html).not.toContain('&lt;li&gt;');
    expect(html).toContain('Punkt A');
    expect(html).toContain('Punkt B');
  });

  it('zeigt keinen escapeten <script>-Tag und keinen Skript-Inhalt', () => {
    const html = feedHtml('Text<script>alert(1)</script>Ende');
    expect(html).not.toContain('&lt;script&gt;');
    expect(html).not.toContain('alert(1)');
  });
});

describe('renderMarkdown — Prosa-Lesbarkeit (max-width-Träger)', () => {
  it('Wrapper trägt die md-prose-Klasse', () => {
    const html = feedHtml('Ein ganz normaler Absatz mit etwas Text.');
    expect(html).toContain('md-prose');
    expect(html).toContain('data-test="md-prose"');
  });

  it('echte Markdown-Liste rendert weiterhin als <ul> (kein Regress)', () => {
    const html = feedHtml('- Eins\n- Zwei');
    // Markdown-`- item` → echtes gerendertes <ul>/<li> (nicht escaped).
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
    expect(html).toContain('Eins');
    expect(html).toContain('Zwei');
  });
});
