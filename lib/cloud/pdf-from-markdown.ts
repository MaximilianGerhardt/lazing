/**
 * Markdown → PDF — Public-Interface (Phase Vercel-NFT-Fix 2026-04-29).
 *
 * This file contains exclusively type defs + an async wrapper.
 * The real implementation (with pdfkit + fs reads + process.cwd) lives
 * in `pdf-from-markdown.impl.ts` and is loaded via dynamic import AT RUNTIME.
 * That way Vercel-Turbopack-NFT tracing never touches the pdfkit data
 * tree and the build passes.
 *
 * Callers import `markdownToPdfBuffer` and call it perfectly normally as
 * `await markdownToPdfBuffer(...)` — the lazy indirection is
 * transparent.
 */

export interface MarkdownToPdfInput {
  title: string;
  markdown: string;
  /** Footer text (small line at bottom right — optional). */
  footer?: string;
  /** A4 (210×297 mm) is the default. */
  pageSize?: "A4" | "LETTER";
  /**
   * Phase ORG SP-7: resolved brand from `lib/branding/resolve.ts`.
   * If set → logo header, brand color as heading accent, footer imprint.
   */
  brand?: {
    orgName: string | null;
    workspaceLabel: string | null;
    logoUrl: string | null;
    brandColors: string[];
    imprintMd: string | null;
    addressLines: string[];
    vatId: string | null;
  };
  /**
   * Recipient context for GDPR auto-imprint:
   *   "external" + brand.imprintMd → imprint shown in the footer.
   *   "internal" → no imprint (minimal footer).
   */
  audience?: "internal" | "external";
}

/**
 * Lazy-loaded markdownToPdfBuffer. The Vercel NFT tracer sees NO
 * fs/pdfkit imports at top level here → the build passes.
 */
export async function markdownToPdfBuffer(
  input: MarkdownToPdfInput,
): Promise<Buffer> {
  const impl = await import("./pdf-from-markdown.impl");
  return impl.markdownToPdfBuffer(input);
}
