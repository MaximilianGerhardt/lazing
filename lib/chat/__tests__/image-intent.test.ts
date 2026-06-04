/**
 * Tests für lib/chat/image-intent.ts — natürlich-sprachliche Bild-Absicht.
 */
import { describe, expect, it } from 'vitest';

import { detectImageIntent } from '../image-intent';

describe('detectImageIntent — positive (Generierung)', () => {
  for (const s of [
    'erstelle ein Bild von einem roten Auto',
    'generiere ein Logo, pitch-black mit grünem Glow',
    'mal mir ein Bild von einer Katze',
    'male ein Bild im Aquarell-Stil',
    'zeichne ein Icon für die App',
    'entwirf ein Cover für das Reel',
    'create an image of a sunset',
    'generate a logo for my agency',
    'mach mir ein Foto-Mockup vom Produkt',
  ]) {
    it(`erkennt: "${s}"`, () => {
      const r = detectImageIntent(s);
      expect(r.isImage).toBe(true);
      expect(r.prompt).toBe(s); // N1 verbatim
    });
  }
});

describe('detectImageIntent — negative', () => {
  for (const s of [
    'zeig mir das letzte Bild',
    'öffne das Bild von vorhin',
    'welches Bild war das nochmal?',
    'wie geht es dir?',
    'erstelle eine Webseite für mich', // Webseite ≠ Bild
    'schreib mir einen Bericht als PDF',
    'manchmal ist normal ganz gut', // „mal"/„normal" dürfen nicht triggern
    '/image ein logo', // Slash-Command nicht abfangen
    'bau mir ein Excel mit Kosten',
  ]) {
    it(`ignoriert: "${s}"`, () => {
      expect(detectImageIntent(s).isImage).toBe(false);
    });
  }
});
