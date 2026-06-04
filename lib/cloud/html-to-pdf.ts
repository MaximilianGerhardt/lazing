/**
 * lib/cloud/html-to-pdf.ts — HTML → PDF (Design-Deck-Pfad, 2026-06-03).
 *
 * Owner insight: a designed HTML deck (with Codex/ImageGen2 visuals) →
 * PDF produces NICER presentations/deliverables than the raw pptx generator.
 * This path renders arbitrary HTML (designed by the agent, laz.ing brand,
 * embedded generated images) headlessly to PDF via Chromium.
 *
 * Local/N2: runs over the already-cached Playwright Chromium (no
 * cloud roundtrip). Mirrors the launch strategy of the verify tests:
 * `channel:'chrome'` first, then the bundled Chromium.
 *
 * N11: a Chromium launch is heavy-ish but transient (one per deck,
 * then close). Single-flight is NOT needed (deck gen is rare); a
 * hard timeout protects against hangs.
 */

import type { Browser } from 'playwright-core';

export interface HtmlToPdfInput {
  /** Complete HTML document (incl. <style>). N1: rendered verbatim. */
  html: string;
  /** Landscape (for decks/pitches). Default false (A4 portrait, documents). */
  landscape?: boolean;
  /** Page format. Default 'A4'. For 16:9 decks e.g. via @page CSS in the HTML. */
  format?: 'A4' | 'A3' | 'Letter';
  /** Print backgrounds/images. Default true (decks have filled areas). */
  printBackground?: boolean;
}

export class HtmlToPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HtmlToPdfError';
  }
}

export const PDF_MIME = 'application/pdf';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 30_000;

async function launchChromium(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  // Like the verify tests: prefer system Chrome, otherwise the bundled Chromium.
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

/**
 * Renders HTML to a PDF buffer. Throws HtmlToPdfError on empty/too-large
 * HTML or a render error. Always closes the browser (finally).
 */
export async function htmlToPdfBuffer(input: HtmlToPdfInput): Promise<Buffer> {
  const html = input?.html ?? '';
  if (html.trim().length === 0) {
    throw new HtmlToPdfError('Leeres HTML.');
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new HtmlToPdfError('HTML zu groß (>5 MB).');
  }

  let browser: Browser | null = null;
  try {
    browser = await launchChromium();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS });
    const pdf = await page.pdf({
      format: input.format ?? 'A4',
      landscape: input.landscape ?? false,
      printBackground: input.printBackground ?? true,
      preferCSSPageSize: true, // lets the HTML set its own slide size via @page
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } catch (err) {
    if (err instanceof HtmlToPdfError) throw err;
    throw new HtmlToPdfError(
      `Chromium-Render fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
