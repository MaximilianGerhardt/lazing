/**
 * lib/chat/image-intent.ts — natural-language image-generation intent.
 *
 * Owner finding (2026-06-03, verbatim): „Kein Image gen aufgerufen — der hat mir ein png
 * erstellt mit html irgendwas … keine Vorschau des Bildes im Chat! Sinnlos."
 * Cause: on „erstelle ein Bild von X" (natural language instead of `/image`)
 * the request went to the agent, which faked the image via HTML/Bash — without
 * a real ImageGen2 generation and without a preview surface.
 *
 * Fix: ChatShell recognizes this intent BEFORE the agent/flow routing (analogous
 * to classifyFlowIntent) and instead emits the `<surface:image-gen>`
 * loading surface (real ImageGen2 + animated preview in the chat).
 *
 * Deterministic (N6), bilingual, conservative: requires a GENERATE verb AND
 * an image noun; pure retrieval/show phrases are excluded.
 */

export interface ImageIntentResult {
  readonly isImage: boolean;
  /** N1: the verbatim user text as the generation prompt. */
  readonly prompt: string;
}

// Generation verbs (DE+EN). Deliberately with word boundaries, to avoid
// falsely matching "normal"/"manchmal" (for "mal").
const GEN_VERB =
  /\b(erstell\w*|generier\w*|erzeug\w*|zeichne?\w*|gestalte?\w*|entwirf|entwerfe?\w*|male?\b|mal\s+mir|mach\s+(mir\s+)?eine?|create|generate|draw|design|render|make\s+(me\s+)?an?)\b/i;

// Image nouns (DE+EN). "bild" exact (not bildschirm/bildung).
const IMG_NOUN =
  /\b(bild|bilder|bildchen|foto|fotos|logo|logos|grafik\w*|illustration\w*|icon|icons|artwork|cover|thumbnail\w*|moodboard|image|images|picture|pictures|photo|photos|drawing|mockup\w*)\b/i;

// Clear retrieval/display intent (NO generation) → exclude.
const RETRIEVAL =
  /\b(zeig\w*|show|öffne|oeffne|lade?\s|finde|find\b|such\w*|welches\s+bild|letztes\s+bild|das\s+bild\s+von\s+vorhin)\b/i;

/**
 * Detects whether `text` is an image-GENERATION request. Conservative.
 * Slash commands (`/…`) are not intercepted (explicit path).
 */
export function detectImageIntent(text: string): ImageIntentResult {
  const t = (text ?? '').trim();
  if (t.length < 4 || t.startsWith('/')) return { isImage: false, prompt: '' };
  const low = t.toLowerCase();
  if (RETRIEVAL.test(low)) return { isImage: false, prompt: '' };
  if (GEN_VERB.test(low) && IMG_NOUN.test(low)) {
    return { isImage: true, prompt: t };
  }
  return { isImage: false, prompt: '' };
}
