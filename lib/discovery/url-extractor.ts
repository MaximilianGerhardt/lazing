/**
 * Slice C · C1 — URL/Domain/Document-Mention Extractor (2026-05-29).
 *
 * Deterministische, IO-arme Vorstufe der Discovery-Phase. Liest den
 * Owner-Prompt (Free-Text), extrahiert:
 *   - URLs (https?://...)
 *   - bare Domains (`www.foo.bar`, `<wort>.<tld>`)
 *   - Document-Mentions (deutsche+englische Keywords wie „Meisterdokument",
 *     „PDF", „attach as file", „sende dir gleich rein", …)
 *
 * Empirie (example-website-3, 2026-05-29): Owner schrieb „example-agency.example … example.com …
 * Meisterdokument" — das System feuerte 0 WebFetch und 0 Doku-Nachfrage. Diese
 * Funktion liefert die Daten, die der Discovery-Orchestrator braucht, um VOR
 * dem Plan-Decompose Recherche zu starten bzw. eine Doku-Anforderung zu
 * surfacen.
 *
 * Disziplin:
 *   - N6: PURE Funktion. Kein I/O, kein LLM, kein Netz. Deterministisch,
 *         sortiert, dedupliziert — selbe Eingabe ⇒ selbe Ausgabe.
 *   - N1: Wir kürzen NICHTS am Ergebnis. Der Caller entscheidet über Budgets.
 *   - N2 unberührt: kein Read aus dem Workspace, keine Audit-Row.
 *   - Fail-soft: leerer/whitespace-only Input ⇒ leere Listen, kein Throw.
 *
 * Was wir NICHT machen (bewusst):
 *   - Keine Heuristik „ist diese URL relevant?" — der Discovery-Orchestrator
 *     entscheidet, ob/welche URLs gefetcht werden.
 *   - Keine Punycode-/IDN-Normalisierung (example-agency.example bleibt example-agency.example).
 *   - Keine HTTPS-Erzwingung (bare Domains werden in der Discovery-Phase mit
 *     `https://` präfixiert, falls relevant).
 */

/** Geschlossene Liste populärer TLDs für bare-Domain-Erkennung (Bare = ohne
 *  Schema). Eng gehalten — wir wollen lieber EINE Domain verpassen, als
 *  jede E-Mail-Adresse als Domain misinterpretieren.
 *
 *  Generische TLDs + häufige Markts-/Länder-TLDs aus dem laz.ing-Umfeld:
 *   - generic: com|net|org|io|app|ai|co|me|dev|page|tech|llc|cloud|tools
 *   - 2-letter-ISO (geöffnet, weil es genug bekannte Country-Domains gibt:
 *     .de, .at, .ch, .uk, .us, .fr, .es, .it, .nl, .pl, .se, .no, .fi, …).
 *   - Wir akzeptieren JEDE 2-letter-Kombination ([a-z]{2}) als ISO-Country;
 *     False-Positives (z.B. „foo.xy") sind selten in Free-Text und werden
 *     vom Fetcher fail-soft behandelt.
 */
const KNOWN_TLDS: ReadonlySet<string> = new Set([
  'com', 'net', 'org', 'io', 'app', 'ai', 'co', 'me', 'dev', 'page',
  'tech', 'llc', 'cloud', 'tools', 'info', 'biz', 'xyz', 'site',
]);

/** Document-Mention-Keywords (DE + EN). Case-insensitiv. Owner-Korpus-orientiert:
 *  „Meisterdokument" ist das Live-Beispiel; wir decken die häufigen Varianten
 *  ab, mit denen der Owner „ich schick dir noch was nach"-Verhalten ankündigt. */
const DOC_MENTION_PATTERNS: ReadonlyArray<RegExp> = [
  // Single-word document nouns (DE + EN)
  /\b(meisterdokument|hauptdokument|dokument(e|en|s)?|datei(en)?|brief(ing)?s?|datasheet|pdf|doc|docx|doku(?:ment)?|spec(?:ification)?|whitepaper|konzept(?:papier)?|strategie[- ]?doc|attachment|anhang|anhänge|anlagen?)\b/i,
  // Phrases (DE) — „sende dir gleich", „schick(e) ich nach", „kommt gleich"
  /\b(sende?|schicke?|schick)\b.{0,30}\b(gleich|noch|nach|dir|euch|rein|zu)\b/i,
  // Phrases (EN) — „attach as file", „send you", „forward"
  /\b(attach(?:ed|ing)?(?:\s+as\s+(?:a\s+)?file)?|i('|')?ll\s+send|forwarding|fwd)\b/i,
];

/**
 * Roh-URL-Regex. Trifft `http://`/`https://` + Host + optionaler Pfad/Query/
 * Fragment bis zum nächsten Whitespace ODER einem typischen Satz-Trenner am
 * Wort-Ende (Punkt/Komma/Semikolon/Ausrufezeichen/Fragezeichen/)/]).
 *
 * Wichtig: das Greedy-Stopzeichen am ENDE wird in `cleanTrailingPunct`
 * nachgereinigt — eine URL „https://foo.bar/baz." soll als „https://foo.bar/baz"
 * landen, NICHT als „https://foo.bar/baz.". Das ist robuster als die Regex
 * mit Negative-Lookbehind zu überladen.
 */
const URL_RE = /https?:\/\/[^\s<>()"']+/gi;

/**
 * Bare-Domain-Regex (KEINE Schema-Präfix, NUR Host). Akzeptiert:
 *   - `www.foo.bar`
 *   - `<sub>.<tld>` (mind. 1 Subdomain-Label vor der TLD, sonst zu viele
 *     False-Positives — „p.a." in Free-Text wäre keine Domain).
 *
 * Vorsichts-Lookbehind/-ahead: kein Buchstabe/@ direkt davor (sonst fangen wir
 * E-Mail-Lokal-Teile), kein Doppelpunkt direkt davor (sonst hätten wir
 * `http://foo.bar` doppelt — die URL_RE hat das bereits gegessen).
 */
const BARE_DOMAIN_RE = /(?<![A-Za-z0-9@.\/])([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?![A-Za-z0-9])/gi;

/** Schlüssel-Ergebnis: alles, was der Discovery-Orchestrator zum Arbeiten
 *  braucht. Felder sind sortiert + dedupliziert (deterministisch). */
export interface ExtractedReferences {
  /** Voll-qualifizierte URLs in Reihenfolge ihres Auftretens (dedup). */
  readonly urls: readonly string[];
  /** Bare Domains (kein Schema). Wenn dieselbe Domain auch als URL auftrat,
   *  taucht sie hier NICHT mehr auf — wir reden über jede Ressource genau
   *  einmal (URL hat Vorrang, weil sie schon einen Pfad mitbringt). */
  readonly bareDomains: readonly string[];
  /** Doku-Mentions als Roh-Snippets (max 200 Zeichen je Match — der Caller
   *  zeigt sie dem User in der „Dokument anfordern"-Liste). */
  readonly documentMentions: readonly string[];
}

/**
 * Hauptfunktion — alles in EINEM Pass:
 *
 *   1. URLs extrahieren (mit trailing-punct-Cleanup).
 *   2. Bare-Domains extrahieren, gefiltert durch KNOWN_TLDS (oder 2-letter-ISO).
 *   3. URL→Host der bereits gefundenen URLs in eine Hide-Liste, damit eine
 *      Domain nicht doppelt (als URL + als bare) auftaucht.
 *   4. Document-Mentions via DOC_MENTION_PATTERNS — pro Match ein kleiner
 *      Kontext-Snippet (±40 Zeichen um den Match).
 *
 * Reihenfolge der Outputs: sortiert nach Auftrittsreihenfolge im Input,
 * danach lexikographisch dedupliziert (stabile Doppel-Detektion).
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

  // 1b. URL-Hosts in lower-case sammeln, um bare-Domain-Doppel zu vermeiden.
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
    // Doppel-Schutz: dieselbe Domain ist bereits in einer URL.
    if (urlHosts.has(lower) || urlHosts.has(`www.${lower}`) || lower.startsWith('www.') && urlHosts.has(lower.slice(4))) {
      continue;
    }
    // TLD-Filter: letztes Label muss in KNOWN_TLDS sein ODER 2-letter-ISO.
    const lastLabel = lower.split('.').pop() ?? '';
    const looksLikeIsoCountry = /^[a-z]{2}$/.test(lastLabel);
    if (!KNOWN_TLDS.has(lastLabel) && !looksLikeIsoCountry) continue;
    bareRaw.push(lower);
  }
  const bareDomains = dedupKeepFirst(bareRaw);

  // 3. Document-Mentions.
  const docMentionsRaw: string[] = [];
  for (const re of DOC_MENTION_PATTERNS) {
    // Globale Variante des Patterns — jeder Treffer wird besucht.
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      const idx = m.index ?? 0;
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + m[0].length + 40);
      docMentionsRaw.push(text.slice(start, end).trim());
    }
  }
  // Dedup + Längen-Cap je Snippet (Schutz vor abnormal langen Whitespace-runs).
  const documentMentions = dedupKeepFirst(
    docMentionsRaw.map((s) => (s.length > 200 ? s.slice(0, 200) : s)),
  );

  return { urls, bareDomains, documentMentions };
}

/**
 * Kürzt typische Satz-/Wort-Schluss-Punktuation am ENDE einer URL ab.
 * Behält interne Zeichen unverändert (Pfad/Query darf '.', ',' etc. enthalten).
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
