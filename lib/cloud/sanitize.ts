/**
 * Filename + Folder-Name Sanitizer.
 *
 * codePoint-based (instead of regex range) so the source code contains no
 * literal control bytes and compiles identically in every toolchain.
 *
 * Strips:
 *   - C0 controls (NUL ... US, 0x00-0x1F)
 *   - DEL (0x7F)
 *   - C1 controls (0x80-0x9F)
 *   - bidi override chars: U+202D LRO, U+202E RLO, U+2066-2069 directional isolates
 *
 * Replaces:
 *   - path separator (/, \) → "_" for filenames
 *
 * Rejects entirely:
 *   - "." and ".."
 *   - folder names with slash/backslash
 */

function isStrippedCodePoint(code: number): boolean {
  if (code <= 0x1f) return true; // C0
  if (code === 0x7f) return true; // DEL
  if (code >= 0x80 && code <= 0x9f) return true; // C1
  if (code === 0x202d || code === 0x202e) return true; // LRO / RLO
  if (code >= 0x2066 && code <= 0x2069) return true; // directional isolates
  return false;
}

export function sanitizeFilename(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (isStrippedCodePoint(code)) continue;
    if (ch === "/" || ch === "\\") {
      out += "_";
      continue;
    }
    out += ch;
  }
  out = out.trim();
  if (out.length === 0 || out === "." || out === "..") return "";
  if (out.length > 255) return out.slice(0, 255);
  return out;
}

export function sanitizeFolderName(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (isStrippedCodePoint(code)) continue;
    out += ch;
  }
  out = out.trim();
  if (out.length === 0) return "";
  if (out.includes("/") || out.includes("\\")) return "";
  if (out === "." || out === "..") return "";
  if (out.length > 128) return out.slice(0, 128);
  return out;
}

/**
 * Workspace-ID validator. Matches the UI pattern in
 * `app/workspaces/[id]/page.tsx` so all paths validate consistently against
 * the same ID class.
 */
export function isValidWorkspaceId(raw: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(raw);
}
