/**
 * lib/privacy/sse-detokenize.ts — detokenize a streamed agent SSE response.
 *
 * The agent server streams `event: token\ndata: {"delta":"…"}` frames. A
 * `[[TYPE_n]]` placeholder can be split across consecutive `token` deltas, so we
 * route the delta text through a stateful stream detokenizer (buffer until a token
 * is complete) and re-emit. Non-token frames (heartbeat / ready / subagent_lane /
 * done / SSE comments) pass through untouched. Before a `done` frame, any held
 * token tail is flushed as a final `token` frame.
 *
 * Used only when LAZYOS_PII_VAULT is on; otherwise the proxy forwards raw bytes.
 */

import { makeStreamDetokenizer } from "./stream-detokenizer";

type RawDb = import("better-sqlite3").Database;

export interface SseDetokenizer {
  /** Transform a raw upstream byte chunk → bytes safe to forward to the client. */
  push(bytes: Uint8Array): Uint8Array;
  /** Emit any buffered partial frame + flushed token tail at stream end. */
  flush(): Uint8Array;
}

const FRAME_SEP = "\n\n";

export function makeSseDetokenizer(raw: RawDb, workspaceId: string): SseDetokenizer {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const detok = makeStreamDetokenizer(raw, workspaceId);
  let frameBuf = "";

  const tokenFrame = (delta: string): string =>
    `event: token\ndata: ${JSON.stringify({ delta })}`;

  function transformFrame(frame: string): string {
    const lines = frame.split("\n");
    const ev = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
    if (ev !== "token") return frame;
    const dataLine = lines.find((l) => l.startsWith("data:"));
    if (!dataLine) return frame;
    try {
      const obj = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
      if (typeof obj.delta === "string") {
        obj.delta = detok.push(obj.delta);
        return `event: token\ndata: ${JSON.stringify(obj)}`;
      }
    } catch {
      /* malformed → pass through unchanged */
    }
    return frame;
  }

  return {
    push(bytes: Uint8Array): Uint8Array {
      frameBuf += decoder.decode(bytes, { stream: true });
      const out: string[] = [];
      let idx: number;
      while ((idx = frameBuf.indexOf(FRAME_SEP)) !== -1) {
        const frame = frameBuf.slice(0, idx);
        frameBuf = frameBuf.slice(idx + FRAME_SEP.length);
        // Flush any held token tail right before the terminal `done` frame.
        if (/^event:\s*done\b/m.test(frame)) {
          const tail = detok.flush();
          if (tail) out.push(tokenFrame(tail));
        }
        out.push(transformFrame(frame));
      }
      if (out.length === 0) return new Uint8Array(0);
      return encoder.encode(out.join(FRAME_SEP) + FRAME_SEP);
    },
    flush(): Uint8Array {
      const tail = detok.flush();
      let s = "";
      if (tail) s += tokenFrame(tail) + FRAME_SEP;
      if (frameBuf) {
        s += frameBuf; // a partial leftover frame (rare); forward verbatim
        frameBuf = "";
      }
      return s ? encoder.encode(s) : new Uint8Array(0);
    },
  };
}
