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
      // Determine how much is safe to emit. Hold back a trailing incomplete token.
      let hold = buf.length;
      const lastOpen = buf.lastIndexOf("[[");
      if (
        lastOpen !== -1 &&
        !buf.slice(lastOpen).includes("]]") &&
        buf.length - lastOpen <= MAX_TOKEN_LEN
      ) {
        hold = lastOpen; // an incomplete "[[…" token starts here
      } else if (buf.endsWith("[")) {
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
