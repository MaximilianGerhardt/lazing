/**
 * build-intent — detects whether a chat message is a concrete "build me that"
 * request, and carries a prompt across a workspace switch.
 *
 * Background (2026-06-02): the default chat runs in the virtual org-root
 * (cross-workspace aggregate, no project). If the user says "bau mir eine
 * App / leg los" there, the client should automatically create a real project
 * workspace, switch to it and carry the build prompt along — instead of being
 * stuck in the virtual root (where the agent can build nothing).
 * `looksLikeBuildIntent` decides conservatively, `stash/takePendingBuild`
 * bridge the reload.
 */

// Build verbs (de/en). Deliberately broad, but only a hit in combination with
// an artifact noun OR an explicit "los" phrase (see below).
const BUILD_VERB =
  /\b(bau|baue|erstell|erstelle|programmier|programmiere|entwickl|entwickle|code|coden|build|create|scaffold|generier|generiere|prototyp(e|ier)?)\b/i;

// Artifact nouns — signal a buildable piece of software.
const ARTIFACT =
  /\b(app|applikation|tool|website|web-?app|seite|page|prototyp|prototype|script|skript|timer|tracker|rechner|calculator|dashboard|spiel|game|widget|generator|konverter|converter|editor|uhr|clock|programm|landing|formular|mini-?app|webseite|html-?seite)\b/i;

// Explicit "get started now / build that" phrases (referring to something
// discussed before, without naming the artifact again).
const GO_PHRASE =
  /(leg(\s+(jetzt|konkret|einfach|mal))?\s+los|lass\s+uns\s+(das\s+)?(bauen|loslegen|starten|umsetzen)|bau(\s+(mir|uns))?\s+(das|es)\b|jetzt\s+bauen|umsetzen\s+bitte|mach\s+(es|das)\s+(jetzt|konkret)|build\s+it|let'?s\s+build)/i;

// Non-build actions (narrow list!) — only clear laz.ing actions, NO words
// that can appear in legitimate app names (e.g. "Notiz-App", "Status-
// Dashboard", "Report-Generator"). Applied ONLY to the context-free "los"
// phrase, not to the verb+artifact path (where the artifact is unambiguous).
const NON_BUILD =
  /\b(ticket|routine|erinner|termin|kalender|rechnung|invoice|heartbeat)\b/i;

/**
 * Conservative: a concrete build request is present if
 *   (a) build verb + artifact noun — a clear artifact (app/tool/timer/…)
 *       ALWAYS wins (also "Notiz-App", "Status-Dashboard"), OR
 *   (b) an explicit "los/build that" phrase WITHOUT a clear non-build word
 *       (contextual, refers to something discussed before).
 */
export function looksLikeBuildIntent(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < 3) return false;
  if (BUILD_VERB.test(t) && ARTIFACT.test(t)) return true; // (a) clear artifact
  if (GO_PHRASE.test(t) && !NON_BUILD.test(t)) return true; // (b) "leg los" etc.
  return false;
}

/**
 * Derives a human-readable project label from the build prompt.
 * Strips leading build verbs/filler words, takes the first meaningful words,
 * caps at ~40 chars. Fallback: "Neues Projekt".
 */
export function deriveProjectLabel(text: string): string {
  let s = (text ?? '')
    .trim()
    .replace(
      /^(bau(e)?|erstell(e)?|programmier(e)?|entwickl(e)?|mach|code|build|create|lass\s+uns|leg\s+(jetzt\s+|konkret\s+|einfach\s+)?los[,:]?)\s+/i,
      '',
    )
    .replace(/^(mir|uns|mal|bitte|doch|hier|jetzt|das|eine?n?|den|die|ein)\s+/i, '')
    .replace(/[.!?][\s\S]*$/, '') // only the first sentence (no dotAll flag, ES2017)
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length === 0) return 'Neues Projekt';
  if (s.length > 40) {
    s = s.slice(0, 40).replace(/\s+\S*$/, ''); // trim at the word boundary
  }
  // Capitalize the first letter.
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Pending build stash (bridges the workspace switch/reload) ──────────
const KEY_PREFIX = 'lazyos.pendingBuild.';

export function stashPendingBuild(workspaceId: string, prompt: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(KEY_PREFIX + workspaceId, prompt);
  } catch {
    /* non-fatal */
  }
}

/** Liest den Pending-Build-Prompt EINMAL aus (und entfernt ihn). */
export function takePendingBuild(workspaceId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.sessionStorage.getItem(KEY_PREFIX + workspaceId);
    if (v !== null) window.sessionStorage.removeItem(KEY_PREFIX + workspaceId);
    return v;
  } catch {
    return null;
  }
}
