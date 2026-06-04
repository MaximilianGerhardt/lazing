/**
 * lib/privacy/stream-detokenizer.ts — stateful detokenizer for STREAMED text.
 *
 * A `[[TYPE_n]]` token can be split across stream chunks (e.g. "[[EMA" then
 * "IL_1]]"). A naive per-chunk detokenize would emit a half-rewritten placeholder.
 * This buffers any trailing text that *could* still be an incomplete token until
 * it either completes (then it's resolved against the local vault) or is proven
 * not to be one. `flush()` emits whatever remains at stream end.
 *
 * Workspace-scoped (N9) — uses the same local vault as the non-streaming path.
 */

import { detokenizeText } from "./pii-vault";

type RawDb = import("better-sqlite3").Database;

// Upper bound on a token: "[[" + TYPE(<=16) + "_" + digits(<=9) + "]]" ~ 31 chars.
// Anything longer than this after a "[[" without a "]]" is not a token → release.
const MAX_TOKEN_LEN = 40;

export interface StreamDetokenizer {
  /** Feed a chunk; returns the text safe to emit now (with complete tokens resolved). */
  push(chunk: string): string;
  /** Emit any held-back tail at stream end. */
  flush(): string;
}

export function makeStreamDetokenizer(raw: RawDb, workspaceId: string): StreamDetokenizer {
  let buf = "";
  const resolve = (s: string): string =>
    s ? detokenizeText(raw, workspaceId, s).text : s;

  return {
    push(chunk: string): string {
      buf += chunk;
      // Determine how much is safe to emit. Everything up to and including the
      // last "]]" is fully resolved, so hold back from the FIRST "[[" that comes
      // after it (the token still streaming). Using the first unclosed open — not
      // the last — avoids emitting an earlier half-written token when a second
      // "[[" arrives in the same buffer.
      let hold = buf.length;
      let searchFrom = buf.lastIndexOf("]]");
      searchFrom = searchFrom === -1 ? 0 : searchFrom + 2;
      // Find the first "[[" whose dangling window is short enough to still be an
      // unclosed token. Skip any "[[" that is already too long to be a token —
      // that one is literal text (so we must NOT hold or release on it), keep
      // scanning. This prevents an over-long literal "[[…" from forcing the whole
      // buffer (incl. a following real partial token) to be released raw.
      for (;;) {
        const dangling = buf.indexOf("[[", searchFrom);
        if (dangling === -1) break;
        if (buf.length - dangling <= MAX_TOKEN_LEN) {
          hold = dangling;
          break;
        }
        searchFrom = dangling + 2;
      }
      if (hold === buf.length && buf.endsWith("[")) {
        hold = buf.length - 1; // a lone trailing "[" could become "[["
      }
      const emit = buf.slice(0, hold);
      buf = buf.slice(hold);
      return resolve(emit);
    },
    flush(): string {
      const out = resolve(buf);
      buf = "";
      return out;
    },
  };
}
