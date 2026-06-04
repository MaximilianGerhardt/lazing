/**
 * Tests für lib/cloud/pptx-from-data.ts (Built-In-Skill json-to-pptx).
 */
import { describe, expect, it } from 'vitest';

import { dataToPptxBuffer, PptxError, PPTX_MIME } from '../pptx-from-data';

describe('dataToPptxBuffer', () => {
  it('erzeugt ein gültiges PPTX (ZIP/PK-Signatur), non-empty, aus title + 2 slides', async () => {
    const buf = await dataToPptxBuffer({
      title: 'Q2 Review',
      subtitle: 'laz.ing Agentur-Bericht',
      slides: [
        {
          title: 'Highlights',
          bullets: ['Umsatz +18 %', 'Drei Neukunden gewonnen'],
        },
        {
          title: 'Ausblick',
          bullets: ['Phase 2 startet Juli'],
          body: 'Weitere Details folgen im nächsten Briefing.',
        },
      ],
      author: 'Max Gerhardt',
    });

    expect(buf.length).toBeGreaterThan(0);
    // PPTX ist ein ZIP → beginnt mit "PK" (0x50 0x4B).
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('erzeugt PPTX ohne optionale Felder (kein subtitle, kein body)', async () => {
    const buf = await dataToPptxBuffer({
      title: 'Minimal-Präsentation',
      slides: [{ title: 'Nur Titel' }, { bullets: ['Punkt A', 'Punkt B'] }],
    });
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('wirft PptxError bei leerer slides-Liste', async () => {
    await expect(
      dataToPptxBuffer({ title: 'Leer', slides: [] }),
    ).rejects.toBeInstanceOf(PptxError);
  });

  it('wirft PptxError wenn zu viele Bullets in einer Folie', async () => {
    const bullets = Array.from({ length: 101 }, (_, i) => `Punkt ${i + 1}`);
    await expect(
      dataToPptxBuffer({
        title: 'Overflow',
        slides: [{ title: 'Zu viele Bullets', bullets }],
      }),
    ).rejects.toBeInstanceOf(PptxError);
  });

  it('wirft PptxError wenn zu viele Folien', async () => {
    const slides = Array.from({ length: 201 }, (_, i) => ({
      title: `Folie ${i + 1}`,
    }));
    await expect(
      dataToPptxBuffer({ title: 'Overflow', slides }),
    ).rejects.toBeInstanceOf(PptxError);
  });

  it('exportiert den korrekten OOXML-MIME', () => {
    expect(PPTX_MIME).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('PptxError hat korrekten name-Wert', () => {
    const err = new PptxError('Test');
    expect(err.name).toBe('PptxError');
    expect(err).toBeInstanceOf(Error);
  });
});
