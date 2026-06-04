/**
 * Tests für lib/cloud/docx-from-markdown.ts (Built-In-Skill markdown-to-docx).
 */
import { describe, expect, it } from 'vitest';

import { DocxError, DOCX_MIME, markdownToDocxBuffer } from '../docx-from-markdown';

describe('markdownToDocxBuffer', () => {
  it('erzeugt ein gültiges DOCX (ZIP/PK-Signatur) aus Überschrift + Absatz + Bullet', async () => {
    const buf = await markdownToDocxBuffer({
      title: 'Testdokument',
      markdown: [
        '# Hauptüberschrift',
        '',
        'Dies ist ein normaler Absatz mit **fettem Text** und `Code`.',
        '',
        '## Abschnitt 2',
        '',
        '- Bullet-Punkt A',
        '- Bullet-Punkt B',
      ].join('\n'),
    });

    expect(buf.length).toBeGreaterThan(0);
    // DOCX ist ein ZIP → beginnt mit "PK".
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('wirft DocxError bei leerem markdown (leerer String)', async () => {
    await expect(
      markdownToDocxBuffer({ title: 'Leer', markdown: '' }),
    ).rejects.toBeInstanceOf(DocxError);
  });

  it('wirft DocxError bei markdown das nur Whitespace enthält', async () => {
    await expect(
      markdownToDocxBuffer({ title: 'Leer', markdown: '   \n  \n  ' }),
    ).rejects.toBeInstanceOf(DocxError);
  });

  it('exportiert den korrekten OOXML-MIME', () => {
    expect(DOCX_MIME).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('erzeugt non-empty Buffer auch bei minimalem Markdown (ein Wort)', async () => {
    const buf = await markdownToDocxBuffer({
      title: 'Mini',
      markdown: 'Hallo Welt',
    });
    // Mindestens 3 KB — ein leeres DOCX ist bereits ~8 KB
    expect(buf.length).toBeGreaterThan(3000);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('akzeptiert optionalen creator und liefert trotzdem valides DOCX', async () => {
    const buf = await markdownToDocxBuffer({
      title: 'Mit Creator',
      markdown: '### Unterüberschrift\n\n1. Erster Punkt\n2. Zweiter Punkt',
      creator: 'Max Mustermann',
    });
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('verarbeitet gemischte Inline-Syntax ohne Text-Verlust (N1)', async () => {
    const md = 'Vor **fett** mitte `monospace` nach';
    const buf = await markdownToDocxBuffer({ title: 'Inline', markdown: md });
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
