/**
 * Slice C · C2 — Discovery-Phase-Orchestrator (2026-05-29).
 *
 * Läuft VOR dem Plan-Decompose (lib/plan-first/plan-dispatch.ts). Sammelt
 * öffentlich erreichbaren Kontext, den der Owner in seinem Free-Text-Prompt
 * referenziert hat (URLs, Domains) — und merkt sich, wenn der Owner ein
 * Dokument ankündigt (z.B. „Meisterdokument als PDF"), damit das System
 * gezielt nachfragen kann statt blind zu starten.
 *
 * Empirie (example-website-3, 2026-05-29): „example-agency.example … example.com … Meisterdokument"
 * → 0 WebFetch + 0 Doku-Nachfrage. Diese Phase liefert genau diese Vorarbeit.
 *
 * Disziplin:
 *   - Fail-soft: ein Fehler bei einer URL kippt nicht das ganze Discovery.
 *     Bei totaler Pleite (Extractor + Fetch beide leer) ⇒ leerer Output ⇒
 *     plan-dispatch verhält sich bit-identisch zum Pre-Discovery-Pfad.
 *   - N1: Markdown-Snapshots werden nach 4KB je URL gekappt — gekappt-Marker
 *     ist sichtbar, NICHT silent.
 *   - N2: WebFetch ist EXTERNAL-only. Kein workspace-cross-scope-Read, keine
 *     Audit-Row (öffentliche URLs sind keine Bridge-Surface).
 *   - N6: parseProposedPlan bleibt deterministisch davor. Der Context-Block
 *     ist NUR LLM-Prompt-Vorarbeit.
 *   - Testbar: `urlFetcher` ist injizierbar — Unit-Tests stubben Net-I/O.
 */

import { extractReferences } from './url-extractor';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DiscoveryUrlStatus = 'ok' | 'failed' | 'timeout';

export interface DiscoveryUrlResult {
  /** Vollqualifizierte URL (https erzwungen für bare Domains). */
  readonly url: string;
  /** Fetch-Status. */
  readonly status: DiscoveryUrlStatus;
  /** Titel aus <title> oder „og:title", falls vorhanden. */
  readonly title?: string;
  /** Komprimierter Markdown-Snapshot (≤ 4KB). Nur bei status=='ok'. */
  readonly summary?: string;
  /** Quelle des Snapshots. Aktuell immer 'fetched' — Reserve für Cache. */
  readonly source: 'fetched';
}

export interface DiscoveryResult {
  /** Pro Referenz ein Eintrag (URL ODER bare-Domain → URL hochgezogen). */
  readonly urls: readonly DiscoveryUrlResult[];
  /** Roh-Snippets der Doku-Mentions aus dem Prompt — Owner-Anker für die
   *  „Dokument anfordern"-Liste in der Discovery-Surface. */
  readonly pendingDocRequests: readonly string[];
  /**
   * Vorgefertigter Markdown-Block, den der Caller dem Plan-Prompt voranstellt.
   * Leer (''), wenn weder URLs noch Doku-Mentions vorhanden sind ⇒ Caller
   * kann ihn unverändert konkatenieren (kein Sonderfall nötig).
   */
  readonly builtContext: string;
}

/** Optionaler Fetcher-Override (für Tests). */
export type UrlFetcher = (url: string, opts: { signal: AbortSignal }) => Promise<FetchPayload>;

export interface FetchPayload {
  /** HTTP-Status-Code (0 bei Netzfehler vor Header). */
  readonly status: number;
  /** Content-Type-Header („text/html; charset=utf-8" o.ä.). */
  readonly contentType?: string;
  /** Roher Body (utf-8 dekodiert). */
  readonly body: string;
}

export interface RunDiscoveryOpts {
  /** Owner-Prompt (Free-Text). */
  readonly intent: string;
  /** Workspace-Scope (N9). Nur für Logging/Trace, kein RAG-Read. */
  readonly workspaceId: string;
  /** Override für Tests. Default: standardFetcher (fetch + 12s timeout). */
  readonly urlFetcher?: UrlFetcher;
  /** Maximale parallele Fetches. Default 5. */
  readonly maxParallel?: number;
  /** Hard timeout je Fetch (ms). Default 12_000. */
  readonly fetchTimeoutMs?: number;
  /** Maximale Anzahl URLs, die gefetcht werden (Rest fliegt raus). Default 8. */
  readonly maxUrls?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_PARALLEL = 5;
const DEFAULT_MAX_URLS = 8;
/** Max bytes pro URL-Snapshot (N1: gekappt-Marker beim Überschreiten). */
const SNAPSHOT_BUDGET_BYTES = 4096;
/** Max Body-Bytes, die wir überhaupt lesen — Schutz vor 100MB-Seiten. */
const RAW_BODY_BUDGET_BYTES = 60 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hauptfunktion: extrahiert Referenzen, fetcht parallel (max 5 simultan),
 * baut den Kontext-Block.
 *
 * Wirft NIE. Bei totaler Pleite (z.B. urlFetcher kippt durchgehend) liefert
 * sie einfach `urls: []` + `builtContext: ''`.
 */
export async function runDiscovery(opts: RunDiscoveryOpts): Promise<DiscoveryResult> {
  void opts.workspaceId; // reserviert für später (z.B. workspace-spezifischer Cache).
  const fetcher = opts.urlFetcher ?? standardFetcher;
  const maxParallel = Math.max(1, opts.maxParallel ?? DEFAULT_MAX_PARALLEL);
  const fetchTimeoutMs = Math.max(1_000, opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
  const maxUrls = Math.max(0, opts.maxUrls ?? DEFAULT_MAX_URLS);

  // 1. Extract.
  const refs = extractReferences(opts.intent);

  // 2. URL-Kandidaten zusammenstellen: URLs (1:1) + bare-Domains → https.
  const candidates: string[] = [
    ...refs.urls,
    ...refs.bareDomains.map((d) => `https://${d}`),
  ];
  // Cap.
  const limited = candidates.slice(0, maxUrls);

  // 3. Parallel fetchen (chunked Promise.allSettled mit Concurrency-Limit).
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

  // 4. Markdown-Kontextblock.
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

/** Default-Fetcher — minimaler `fetch` mit Größenlimit. Fail-soft. */
async function standardFetcher(
  url: string,
  opts: { signal: AbortSignal },
): Promise<FetchPayload> {
  const resp = await fetch(url, {
    signal: opts.signal,
    redirect: 'follow',
    headers: {
      // Höflicher UA — manche Hosts blocken sonst.
      'user-agent': 'laz.ing-discovery/1.0 (+https://laz.ing)',
      accept: 'text/html, application/xhtml+xml; q=0.9, */*; q=0.5',
    },
  });
  const contentType = resp.headers.get('content-type') ?? undefined;
  // Body cap: streamen wir nicht weiter als RAW_BODY_BUDGET_BYTES.
  const body = await readBodyCapped(resp, RAW_BODY_BUDGET_BYTES);
  return {
    status: resp.status,
    ...(contentType ? { contentType } : {}),
    body,
  };
}

/**
 * Liest die Response bis max `limit` Bytes — verhindert, dass eine 100MB-Seite
 * den Prozess saugt. Bei Limit-Überschreitung wird abgebrochen.
 */
async function readBodyCapped(resp: Response, limit: number): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // Fallback: kompletter Text (z.B. polyfilled fetch in Tests).
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
 * Verarbeitet eine erfolgreiche Fetch-Response: extrahiert Title +
 * Meta-Description + erste ~300 Wörter Body → Markdown-Snapshot ≤ 4KB.
 *
 * Kein DOM-Dep — pures Regex/String-Stripping. Genug für Snapshots; KEIN
 * Anspruch auf semantische HTML-Treue.
 */
function processFetched(url: string, payload: FetchPayload): DiscoveryUrlResult {
  // HTTP-Fehler-Codes ⇒ failed, kein Snapshot.
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

/** <title>X</title> ODER og:title als Fallback. */
function extractTitle(html: string): string | undefined {
  const m1 = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (m1?.[1]) return decodeEntities(m1[1].trim());
  const m2 = /<meta\s+(?:[^>]*?\s+)?property=["']og:title["'][^>]*?content=["']([^"']+)["']/i.exec(html);
  if (m2?.[1]) return decodeEntities(m2[1].trim());
  return undefined;
}

/** Meta-Description ODER og:description als Fallback. */
function extractMetaDescription(html: string): string | undefined {
  const m1 = /<meta\s+(?:[^>]*?\s+)?name=["']description["'][^>]*?content=["']([^"']+)["']/i.exec(html);
  if (m1?.[1]) return decodeEntities(m1[1].trim());
  const m2 = /<meta\s+(?:[^>]*?\s+)?property=["']og:description["'][^>]*?content=["']([^"']+)["']/i.exec(html);
  if (m2?.[1]) return decodeEntities(m2[1].trim());
  return undefined;
}

/**
 * Sehr schlanker HTML→Markdown-Stripper:
 *   - <script>/<style>/<noscript>/<svg> komplett entfernen
 *   - Block-Tags → Newline-Marker
 *   - <h1..h6> → '# '-Präfix (eine Ebene runter pro Stufe)
 *   - Restliche Tags entfernen, Entities decodieren
 *   - Whitespace normalisieren, erste ~300 Wörter behalten
 *
 * Bewusst dumm — der Snapshot dient als Kontext für den Plan-LLM, NICHT als
 * konvertiertes Dokument.
 */
function stripToMarkdown(html: string): string {
  let s = html;
  // Heavy-Tags raus.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  // Headings zu Markdown.
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
  // Block-Tags → Newlines.
  s = s.replace(/<(?:p|li|br|div|section|article|tr|td|th)[^>]*>/gi, '\n');
  s = s.replace(/<\/(?:p|li|div|section|article|ul|ol|tr)[^>]*>/gi, '\n');
  // Strip rest.
  s = s.replace(/<[^>]+>/g, ' ');
  // Entities.
  s = decodeEntities(s);
  // Whitespace.
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Erste ~300 Wörter.
  const words = s.split(/\s+/);
  const cap = words.slice(0, 300).join(' ');
  return cap;
}

/** Häufige HTML-Entities — keine vollständige Liste (Snapshot ≠ Renderer). */
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
 * Führt `fn(item)` mit Concurrency-Limit aus. Bei Fehler im `fn` wird der
 * Wurf vom Caller (processFetched) abgefangen — hier kommt `T` zurück.
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
      // Sicher: items.length > i wurde gerade geprüft.
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
 * Baut den Block, den plan-dispatch dem Plan-Prompt voranstellt. Reihenfolge
 * laut Spec: Discovery > WHY > Intent. plan-dispatch hängt Discovery vor den
 * whyContext-String und übergibt das Konkat als `whyContext` an
 * proposeRecursivePlan — proposePlan stellt es bit-identisch dem Basis-
 * Prompt voran (siehe lib/plan-first/orchestrate-plan.ts:319-323).
 *
 * Wenn weder URLs noch DocMentions vorhanden sind ⇒ leerer String — der
 * Caller kann ihn unverändert konkatenieren.
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
          // Snapshot eingerückt als Block-Zitat.
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
