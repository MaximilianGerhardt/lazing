/**
 * Slice C · C2 — discovery-phase orchestrator (2026-05-29).
 *
 * Runs BEFORE the plan decompose (lib/plan-first/plan-dispatch.ts). Collects
 * publicly reachable context that the owner referenced in their free-text prompt
 * (URLs, domains) — and remembers when the owner announces a
 * document (e.g. „Meisterdokument als PDF"), so the system can
 * ask specifically instead of starting blindly.
 *
 * Empirical (example-website-3, 2026-05-29): „example-agency.example … example.com … Meisterdokument"
 * → 0 WebFetch + 0 doc inquiry. This phase delivers exactly that preparation.
 *
 * Discipline:
 *   - Fail-soft: an error on one URL does not tip the whole discovery.
 *     On a total bust (extractor + fetch both empty) ⇒ empty output ⇒
 *     plan-dispatch behaves bit-identically to the pre-discovery path.
 *   - N1: markdown snapshots are capped at 4KB per URL — the capped marker
 *     is visible, NOT silent.
 *   - N2: WebFetch is EXTERNAL-only. No workspace cross-scope read, no
 *     audit row (public URLs are not a bridge surface).
 *   - N6: parseProposedPlan stays deterministic afterwards. The context block
 *     is ONLY LLM-prompt preparation.
 *   - Testable: `urlFetcher` is injectable — unit tests stub net I/O.
 */

import { extractReferences } from './url-extractor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiscoveryUrlStatus = 'ok' | 'failed' | 'timeout';

export interface DiscoveryUrlResult {
  /** Fully-qualified URL (https forced for bare domains). */
  readonly url: string;
  /** Fetch status. */
  readonly status: DiscoveryUrlStatus;
  /** Title from <title> or „og:title", if present. */
  readonly title?: string;
  /** Compressed markdown snapshot (≤ 4KB). Only on status=='ok'. */
  readonly summary?: string;
  /** Source of the snapshot. Currently always 'fetched' — reserve for cache. */
  readonly source: 'fetched';
}

export interface DiscoveryResult {
  /** One entry per reference (URL OR bare domain → URL pulled up). */
  readonly urls: readonly DiscoveryUrlResult[];
  /** Raw snippets of the doc mentions from the prompt — owner anchors for the
   *  „Dokument anfordern" list in the discovery surface. */
  readonly pendingDocRequests: readonly string[];
  /**
   * Pre-built markdown block that the caller prepends to the plan prompt.
   * Empty (''), when neither URLs nor doc mentions are present ⇒ the caller
   * can concatenate it unchanged (no special case needed).
   */
  readonly builtContext: string;
}

/** Optional fetcher override (for tests). */
export type UrlFetcher = (url: string, opts: { signal: AbortSignal }) => Promise<FetchPayload>;

export interface FetchPayload {
  /** HTTP status code (0 on a network error before headers). */
  readonly status: number;
  /** Content-Type header („text/html; charset=utf-8" or similar). */
  readonly contentType?: string;
  /** Raw body (utf-8 decoded). */
  readonly body: string;
}

export interface RunDiscoveryOpts {
  /** Owner prompt (free text). */
  readonly intent: string;
  /** Workspace scope (N9). Only for logging/trace, no RAG read. */
  readonly workspaceId: string;
  /** Override for tests. Default: standardFetcher (fetch + 12s timeout). */
  readonly urlFetcher?: UrlFetcher;
  /** Maximum parallel fetches. Default 5. */
  readonly maxParallel?: number;
  /** Hard timeout per fetch (ms). Default 12_000. */
  readonly fetchTimeoutMs?: number;
  /** Maximum number of URLs to fetch (the rest is dropped). Default 8. */
  readonly maxUrls?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_PARALLEL = 5;
const DEFAULT_MAX_URLS = 8;
/** Max bytes per URL snapshot (N1: capped marker on overflow). */
const SNAPSHOT_BUDGET_BYTES = 4096;
/** Max body bytes we read at all — protection against 100MB pages. */
const RAW_BODY_BUDGET_BYTES = 60 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main function: extracts references, fetches in parallel (max 5 simultaneous),
 * builds the context block.
 *
 * NEVER throws. On a total bust (e.g. urlFetcher fails throughout) it simply
 * returns `urls: []` + `builtContext: ''`.
 */
export async function runDiscovery(opts: RunDiscoveryOpts): Promise<DiscoveryResult> {
  void opts.workspaceId; // reserved for later (e.g. workspace-specific cache).
  const fetcher = opts.urlFetcher ?? standardFetcher;
  const maxParallel = Math.max(1, opts.maxParallel ?? DEFAULT_MAX_PARALLEL);
  const fetchTimeoutMs = Math.max(1_000, opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const maxUrls = Math.max(0, opts.maxUrls ?? DEFAULT_MAX_URLS);

  // 1. Extract.
  const refs = extractReferences(opts.intent);

  // 2. Assemble URL candidates: URLs (1:1) + bare domains → https.
  const candidates: string[] = [
    ...refs.urls,
    ...refs.bareDomains.map((d) => `https://${d}`),
  ];
  // Cap.
  const limited = candidates.slice(0, maxUrls);

  // 3. Fetch in parallel (chunked Promise.allSettled with a concurrency limit).
  const fetched = limited.length > 0
    ? await fetchInBatches(limited, maxParallel, async (url) => {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort('discovery-timeout'), fetchTimeoutMs);
        try {
          const payload = await fetcher(url, { signal: ctl.signal });
          return processFetched(url, payload);
        } catch (err) {
          const isTimeout =
            err instanceof Error && /abort|timeout/i.test(err.message);
          return {
            url,
            status: (isTimeout ? 'timeout' : 'failed') as DiscoveryUrlStatus,
            source: 'fetched' as const,
          };
        } finally {
          clearTimeout(t);
        }
      })
    : [];

  // 4. Markdown context block.
  const builtContext = renderDiscoveryContextBlock(fetched, refs.documentMentions);

  return {
    urls: fetched,
    pendingDocRequests: refs.documentMentions,
    builtContext,
  };
}

// ---------------------------------------------------------------------------
// Internal: fetcher
// ---------------------------------------------------------------------------

/** Default fetcher — minimal `fetch` with a size limit. Fail-soft. */
async function standardFetcher(
  url: string,
  opts: { signal: AbortSignal },
): Promise<FetchPayload> {
  const resp = await fetch(url, {
    signal: opts.signal,
    redirect: 'follow',
    headers: {
      // Polite UA — some hosts block otherwise.
      'user-agent': 'laz.ing-discovery/1.0 (+https://laz.ing)',
      accept: 'text/html, application/xhtml+xml; q=0.9, */*; q=0.5',
    },
  });
  const contentType = resp.headers.get('content-type') ?? undefined;
  // Body cap: we do not stream further than RAW_BODY_BUDGET_BYTES.
  const body = await readBodyCapped(resp, RAW_BODY_BUDGET_BYTES);
  return {
    status: resp.status,
    ...(contentType ? { contentType } : {}),
    body,
  };
}

/**
 * Reads the response up to max `limit` bytes — prevents a 100MB page
 * from sucking the process dry. On exceeding the limit it aborts.
 */
async function readBodyCapped(resp: Response, limit: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // Fallback: full text (e.g. polyfilled fetch in tests).
    const t = await resp.text();
    return t.length > limit ? t.slice(0, limit) : t;
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (total >= limit) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  out += decoder.decode();
  return out;
}

// ---------------------------------------------------------------------------
// Internal: html → markdown snapshot
// ---------------------------------------------------------------------------

/**
 * Processes a successful fetch response: extracts title +
 * meta description + the first ~300 words of body → markdown snapshot ≤ 4KB.
 *
 * No DOM dep — pure regex/string stripping. Enough for snapshots; NO
 * claim to semantic HTML fidelity.
 */
function processFetched(url: string, payload: FetchPayload): DiscoveryUrlResult {
  // HTTP error codes ⇒ failed, no snapshot.
  if (payload.status === 0 || payload.status >= 400) {
    return { url, status: 'failed', source: 'fetched' };
  }

  const html = payload.body;
  const title = extractTitle(html);
  const desc = extractMetaDescription(html);
  const body = stripToMarkdown(html);

  const parts: string[] = [];
  if (desc) parts.push(`> ${desc}`);
  if (body) parts.push(body);
  let summary = parts.join('\n\n').trim();
  if (summary.length > SNAPSHOT_BUDGET_BYTES) {
    summary = summary.slice(0, SNAPSHOT_BUDGET_BYTES) + '\n…(gekürzt)';
  }

  return {
    url,
    status: 'ok',
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    source: 'fetched',
  };
}

/** <title>X</title> OR og:title as a fallback. */
function extractTitle(html: string): string | undefined {
  const m1 = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (m1?.[1]) return decodeEntities(m1[1].trim());
  const m2 = /<meta\s+(?:[^>]*?\s+)?property=["']og:title["'][^>]*?content=["']([^"']+)["']/i.exec(html);
  if (m2?.[1]) return decodeEntities(m2[1].trim());
  return undefined;
}

/** Meta description OR og:description as a fallback. */
function extractMetaDescription(html: string): string | undefined {
  const m1 = /<meta\s+(?:[^>]*?\s+)?name=["']description["'][^>]*?content=["']([^"']+)["']/i.exec(html);
  if (m1?.[1]) return decodeEntities(m1[1].trim());
  const m2 = /<meta\s+(?:[^>]*?\s+)?property=["']og:description["'][^>]*?content=["']([^"']+)["']/i.exec(html);
  if (m2?.[1]) return decodeEntities(m2[1].trim());
  return undefined;
}

/**
 * Very lean HTML→Markdown stripper:
 *   - remove <script>/<style>/<noscript>/<svg> completely
 *   - block tags → newline markers
 *   - <h1..h6> → '# ' prefix (one level down per step)
 *   - remove remaining tags, decode entities
 *   - normalize whitespace, keep the first ~300 words
 *
 * Deliberately dumb — the snapshot serves as context for the plan LLM, NOT as a
 * converted document.
 */
function stripToMarkdown(html: string): string {
  let s = html;
  // Heavy tags out.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  // Headings to Markdown.
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  // Block tags → newlines.
  s = s.replace(/<(?:p|li|br|div|section|article|tr|td|th)[^>]*>/gi, '\n');
  s = s.replace(/<\/(?:p|li|div|section|article|ul|ol|tr)[^>]*>/gi, '\n');
  // Strip rest.
  s = s.replace(/<[^>]+>/g, ' ');
  // Entities.
  s = decodeEntities(s);
  // Whitespace.
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // First ~300 words.
  const words = s.split(/\s+/);
  const cap = words.slice(0, 300).join(' ');
  return cap;
}

/** Common HTML entities — not a complete list (snapshot ≠ renderer). */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;/g, "'")
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return '';
      }
    });
}

// ---------------------------------------------------------------------------
// Internal: concurrency-limited batches
// ---------------------------------------------------------------------------

/**
 * Runs `fn(item)` with a concurrency limit. On an error in `fn` the
 * throw is caught by the caller (processFetched) — here `T` comes back.
 */
async function fetchInBatches<I, T>(
  items: readonly I[],
  limit: number,
  fn: (item: I) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let i = 0;
  const workers: Promise<void>[] = [];
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      // Safe: items.length > i was just checked.
      results[idx] = await fn(items[idx]!);
    }
  };
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push(next());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Internal: context-block renderer
// ---------------------------------------------------------------------------

const DISCOVERY_HEADER = 'Aktuelle Discovery (vor dem Plan)';

/**
 * Builds the block that plan-dispatch prepends to the plan prompt. Order
 * per spec: Discovery > WHY > Intent. plan-dispatch puts Discovery before the
 * whyContext string and passes the concatenation as `whyContext` to
 * proposeRecursivePlan — proposePlan prepends it bit-identically to the base
 * prompt (see lib/plan-first/orchestrate-plan.ts:319-323).
 *
 * When neither URLs nor doc mentions are present ⇒ empty string — the
 * caller can concatenate it unchanged.
 */
export function renderDiscoveryContextBlock(
  urls: readonly DiscoveryUrlResult[],
  docMentions: readonly string[],
): string {
  if (urls.length === 0 && docMentions.length === 0) return '';
  const lines: string[] = [];
  lines.push(`### ${DISCOVERY_HEADER}`);
  if (urls.length > 0) {
    lines.push('');
    lines.push('Folgende vom Owner referenzierten Quellen wurden vor dem Plan abgerufen:');
    for (const u of urls) {
      if (u.status === 'ok') {
        const head = u.title ? `**${u.title}** — ${u.url}` : `**${u.url}**`;
        lines.push('');
        lines.push(`- ${head}`);
        if (u.summary) {
          // Snapshot indented as a block quote.
          const indented = u.summary
            .split('\n')
            .map((ln) => `  > ${ln}`)
            .join('\n');
          lines.push(indented);
        }
      } else {
        lines.push('');
        lines.push(`- ${u.url} — _nicht erreichbar (${u.status})_`);
      }
    }
  }
  if (docMentions.length > 0) {
    lines.push('');
    lines.push('Der Owner hat im Prompt Dokumente angekündigt:');
    for (const m of docMentions) {
      lines.push(`- „…${m}…"`);
    }
    lines.push('');
    lines.push(
      'Berücksichtige im Plan einen expliziten Schritt, der diese Dokumente vom Owner anfordert, BEVOR Annahmen getroffen werden.',
    );
  }
  return lines.join('\n');
}
