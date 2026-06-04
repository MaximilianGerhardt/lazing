/**
 * Slice C · C1 — URL-Extractor Unit-Tests (2026-05-29).
 *
 * Deterministisch (N6), zero-I/O. Empirie-Fall (example-website-3): der Owner-Prompt
 * trug „example-agency.example" + „example.com" + „Meisterdokument" — der Extractor MUSS diese
 * Signale liefern, damit Discovery vor Plan-Decompose feuern kann.
 */

import { describe, it, expect } from 'vitest';
import { extractReferences } from '../url-extractor';

describe('extractReferences — Empirie: Owner-Prompt example-website-3', () => {
  it('erkennt example-agency.example + example.com + Meisterdokument', () => {
    const input =
      'Bitte schau dir example-agency.example und meine Firma example.com an. ' +
      'Ich sende dir gleich das Meisterdokument als PDF.';
    const r = extractReferences(input);
    expect(r.bareDomains).toContain('example-agency.example');
    expect(r.bareDomains).toContain('example.com');
    expect(r.urls).toEqual([]);
    expect(r.documentMentions.length).toBeGreaterThan(0);
    expect(r.documentMentions.join(' ')).toMatch(/Meisterdokument/i);
  });

  it('vollqualifizierte URLs werden extrahiert + trailing-punct gestrippt', () => {
    const input =
      'Refs: https://example.com/about. Auch http://foo.io/x?y=1, https://laz.ing/path)';
    const r = extractReferences(input);
    expect(r.urls).toEqual([
      'https://example.com/about',
      'http://foo.io/x?y=1',
      'https://laz.ing/path',
    ]);
  });

  it('dedupliziert URLs in Auftrittsreihenfolge', () => {
    const input = 'A https://a.io B https://b.io C https://a.io D';
    const r = extractReferences(input);
    expect(r.urls).toEqual(['https://a.io', 'https://b.io']);
  });

  it('bare Domain wird unterdrückt, wenn dieselbe Domain als URL vorkam', () => {
    const input = 'siehe https://example-agency.example/about und example-agency.example';
    const r = extractReferences(input);
    expect(r.urls).toEqual(['https://example-agency.example/about']);
    expect(r.bareDomains).toEqual([]);
  });

  it('verwirft Müll-Domain ohne bekannte TLD', () => {
    const input = 'foo.zzzz und bar.qx9'; // qx9 ist 3-stellig, nicht in KNOWN_TLDS
    const r = extractReferences(input);
    expect(r.bareDomains).toEqual([]);
  });

  it('akzeptiert 2-Letter-ISO-TLDs (de, at, ch, uk, …)', () => {
    const input = 'crm.kunde.at, vw.de, web.uk - oder bahn.ch';
    const r = extractReferences(input);
    expect(r.bareDomains).toContain('crm.kunde.at');
    expect(r.bareDomains).toContain('vw.de');
    expect(r.bareDomains).toContain('web.uk');
    expect(r.bareDomains).toContain('bahn.ch');
  });

  it('erkennt englische Dokument-Mention („attach as file")', () => {
    const input = 'I will attach as file shortly, see the brief.';
    const r = extractReferences(input);
    expect(r.documentMentions.length).toBeGreaterThan(0);
  });

  it('erkennt deutsche „sende dir gleich rein"-Phrase', () => {
    const input = 'Ich sende dir gleich rein, was wir besprochen haben.';
    const r = extractReferences(input);
    expect(r.documentMentions.length).toBeGreaterThan(0);
  });

  it('leerer / whitespace Input ⇒ leere Listen, kein Throw', () => {
    expect(extractReferences('')).toEqual({
      urls: [], bareDomains: [], documentMentions: [],
    });
    expect(extractReferences('   \n\t ')).toEqual({
      urls: [], bareDomains: [], documentMentions: [],
    });
  });

  it('deterministisch — selbe Eingabe ⇒ identische Ausgabe', () => {
    const input = 'a https://x.io b foo.de c bar.com d Meisterdokument';
    const r1 = extractReferences(input);
    const r2 = extractReferences(input);
    expect(r1).toEqual(r2);
  });

  it('schluckt E-Mail-Adressen nicht als Domain', () => {
    const input = 'kontakt@example-agency.example schreibt: schaut auf example.com';
    const r = extractReferences(input);
    // example-agency.example kommt aus der Mail — wir akzeptieren bewusst kein
    // E-Mail-Local-Teil-Splitting; BARE_DOMAIN_RE verlangt KEIN Buchstabe/@
    // davor → example-agency.example fällt aus dem Match.
    expect(r.bareDomains).not.toContain('example-agency.example');
    expect(r.bareDomains).toContain('example.com');
  });

  it('eine ganze Owner-Nachricht (Smoke): URLs + bare + DocMention', () => {
    const input =
      'Ich möchte eine Webseite bauen für example.com. Schau dir ' +
      'https://example-agency.example/cases bitte an. Briefing kommt als PDF, ' +
      'sende dir gleich noch das Meisterdokument.';
    const r = extractReferences(input);
    expect(r.urls).toContain('https://example-agency.example/cases');
    expect(r.bareDomains).toContain('example.com');
    expect(r.documentMentions.length).toBeGreaterThan(0);
  });
});
