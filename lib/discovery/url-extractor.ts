/**
 * Slice C · C1 — URL/domain/document-mention extractor (2026-05-29).
 *
 * Deterministic, IO-light pre-stage of the discovery phase. Reads the
 * owner prompt (free text), extracts:
 *   - URLs (https?://...)
 *   - bare domains (`www.foo.bar`, `<word>.<tld>`)
 *   - document mentions (German+English keywords like „Meisterdokument",
 *     „PDF", „attach as file", „sende dir gleich rein", …)
 *
 * Empirical (example-website-3, 2026-05-29): the owner wrote „example-agency.example … example.com …
 * Meisterdokument" — the system fired 0 WebFetch and 0 doc inquiry. This
 * function delivers the data the discovery orchestrator needs to start research
 * BEFORE the plan decompose or to surface a doc request.
 *
 * Discipline:
 *   - N6: PURE function. No I/O, no LLM, no network. Deterministic,
 *         sorted, deduplicated — same input ⇒ same output.
 *   - N1: we truncate NOTHING in the result. The caller decides on budgets.
 *   - N2 untouched: no read from the workspace, no audit row.
 *   - Fail-soft: empty/whitespace-only input ⇒ empty lists, no throw.
 *
 * What we do NOT do (deliberately):
 *   - No heuristic "is this URL relevant?" — the discovery orchestrator
 *     decides whether/which URLs are fetched.
 *   - No punycode/IDN normalization (example-agency.example stays example-agency.example).
 *   - No HTTPS enforcement (bare domains are prefixed with `https://` in the
 *     discovery phase, if relevant).
 */

/** Closed list of popular TLDs for bare-domain detection (bare = without
 *  scheme). Kept tight — we would rather miss ONE domain than
 *  misinterpret every email address as a domain.
 *
 *  Generic TLDs + common market/country TLDs from the laz.ing context:
 *   - generic: com|net|org|io|app|ai|co|me|dev|page|tech|llc|cloud|tools
 *   - 2-letter ISO (opened, because there are enough known country domains:
 *     .de, .at, .ch, .uk, .us, .fr, .es, .it, .nl, .pl, .se, .no, .fi, …).
 *   - We accept ANY 2-letter combination ([a-z]{2}) as an ISO country;
 *     false positives (e.g. „foo.xy") are rare in free text and are
 *     handled fail-soft by the fetcher.
 */
const KNOWN_TLDS: ReadonlySet<string> = new Set([
  'com', 'net', 'org', 'io', 'app', 'ai', 'co', 'me', 'dev', 'page',
  'tech', 'llc', 'cloud', 'tools', 'info', 'biz', 'xyz', 'site',
]);

/** Document-mention keywords (DE + EN). Case-insensitive. Owner-corpus-oriented:
 *  „Meisterdokument" is the live example; we cover the common variants
 *  with which the owner announces the „I'll send you something later" behavior. */
const DOC_MENTION_PATTERNS: ReadonlyArray<RegExp> = [
  // Single-word document nouns (DE + EN)
  /\b(meisterdokument|hauptdokument|dokument(e|en|s)?|datei(en)?|brief(ing)?s?|datasheet|pdf|doc|docx|doku(?:ment)?|spec(?:ification)?|whitepaper|konzept(?:papier)?|strategie[- ]?doc|attachment|anhang|anhänge|anlagen?)\b/i,
  // Phrases (DE) — „sende dir gleich", „schick(e) ich nach", „kommt gleich"
  /\b(sende?|schicke?|schick)\b.{0,30}\b(gleich|noch|nach|dir|euch|rein|zu)\b/i,
  // Phrases (EN) — „attach as file", „send you", „forward"
  /\b(attach(?:ed|ing)?(?:\s+as\s+(?:a\s+)?file)?|i('|')?ll\s+send|forwarding|fwd)\b/i,
];

/**
 * Raw URL regex. Matches `http://`/`https://` + host + optional path/query/
 * fragment up to the next whitespace OR a typical sentence separator at the
 * word end (period/comma/semicolon/exclamation/question/)/]).
 *
 * Important: the greedy stop character at the END is cleaned up in
 * `cleanTrailingPunct` — a URL „https://foo.bar/baz." should land as
 * „https://foo.bar/baz", NOT as „https://foo.bar/baz.". That is more robust than
 * overloading the regex with a negative lookbehind.
 */
const URL_RE = /https?:\/\/[^\s<>()"']+/gi;

/**
 * Bare-domain regex (NO scheme prefix, ONLY host). Accepts:
 *   - `www.foo.bar`
 *   - `<sub>.<tld>` (at least 1 subdomain label before the TLD, otherwise too many
 *     false positives — „p.a." in free text would not be a domain).
 *
 * Caution lookbehind/-ahead: no letter/@ directly before (otherwise we catch
 * email local parts), no colon directly before (otherwise we would have
 * `http://foo.bar` twice — URL_RE has already eaten that).
 */
const BARE_DOMAIN_RE = /(?<![A-Za-z0-9@.\/])([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?![A-Za-z0-9])/gi;

/** Key result: everything the discovery orchestrator needs to work.
 *  Fields are sorted + deduplicated (deterministic). */
export interface ExtractedReferences {
  /** Fully-qualified URLs in order of their appearance (dedup). */
  readonly urls: readonly string[];
  /** Bare domains (no scheme). If the same domain also appeared as a URL,
   *  it does NOT show up here again — we talk about each resource exactly
   *  once (the URL takes precedence because it already brings a path). */
  readonly bareDomains: readonly string[];
  /** Doc mentions as raw snippets (max 200 chars per match — the caller
   *  shows them to the user in the „Dokument anfordern" list). */
  readonly documentMentions: readonly string[];
}

/**
 * Main function — everything in ONE pass:
 *
 *   1. Extract URLs (with trailing-punct cleanup).
 *   2. Extract bare domains, filtered by KNOWN_TLDS (or 2-letter ISO).
 *   3. URL→host of the already-found URLs into a hide list, so a
 *      domain does not appear twice (as URL + as bare).
 *   4. Document mentions via DOC_MENTION_PATTERNS — per match a small
 *      context snippet (±40 chars around the match).
 *
 * Order of the outputs: sorted by order of appearance in the input,
 * then lexicographically deduplicated (stable double detection).
 */
export function extractReferences(text: string): ExtractedReferences {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { urls: [], bareDomains: [], documentMentions: [] };
  }

  // 1. URLs.
  const urlsRaw: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    urlsRaw.push(cleanTrailingPunct(m[0]));
  }
  const urls = dedupKeepFirst(urlsRaw);

  // 1b. Collect URL hosts in lower-case to avoid bare-domain duplicates.
  const urlHosts = new Set<string>();
  for (const u of urls) {
    const host = hostFromUrl(u);
    if (host) urlHosts.add(host.toLowerCase());
  }

  // 2. Bare-Domains.
  const bareRaw: string[] = [];
  for (const m of text.matchAll(BARE_DOMAIN_RE)) {
    const candidate = m[1];
    if (!candidate) continue;
    const lower = candidate.toLowerCase();
    // Double protection: the same domain is already in a URL.
    if (urlHosts.has(lower) || urlHosts.has(`www.${lower}`) || lower.startsWith('www.') && urlHosts.has(lower.slice(4))) {
      continue;
    }
    // TLD filter: the last label must be in KNOWN_TLDS OR a 2-letter ISO.
    const lastLabel = lower.split('.').pop() ?? '';
    const looksLikeIsoCountry = /^[a-z]{2}$/.test(lastLabel);
    if (!KNOWN_TLDS.has(lastLabel) && !looksLikeIsoCountry) continue;
    bareRaw.push(lower);
  }
  const bareDomains = dedupKeepFirst(bareRaw);

  // 3. Document-Mentions.
  const docMentionsRaw: string[] = [];
  for (const re of DOC_MENTION_PATTERNS) {
    // Global variant of the pattern — every match is visited.
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      const idx = m.index ?? 0;
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + m[0].length + 40);
      docMentionsRaw.push(text.slice(start, end).trim());
    }
  }
  // Dedup + length cap per snippet (protection against abnormally long whitespace runs).
  const documentMentions = dedupKeepFirst(
    docMentionsRaw.map((s) => (s.length > 200 ? s.slice(0, 200) : s)),
  );

  return { urls, bareDomains, documentMentions };
}

/**
 * Trims typical sentence/word-end punctuation at the END of a URL.
 * Keeps internal characters unchanged (path/query may contain '.', ',' etc.).
 */
function cleanTrailingPunct(s: string): string {
  let end = s.length;
  while (end > 0 && /[.,;:!?)\]}>]/.test(s[end - 1]!)) end--;
  return s.slice(0, end);
}

/** Extrahiert den Host aus einer URL ohne `new URL()` — Bun/Edge-safe. */
function hostFromUrl(url: string): string | null {
  const m = /^https?:\/\/([^\/\s?#]+)/i.exec(url);
  return m ? (m[1] ?? null) : null;
}

/** Order-stable dedup. */
function dedupKeepFirst<T>(xs: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
