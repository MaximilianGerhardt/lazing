'use client';

/**
 * Minimal chat streaming hook for the lazyOS real-agent.
 *
 * We deliberately do NOT pull in `ai/react` — the public API there is a
 * moving target across majors and we only need the following:
 *
 *   • POST a message list to `/api/chat/stream`
 *   • Stream the response as plain text (not SSE)
 *   • Parse surface-block XML tags on the fly
 *   • Expose mid-stream UI state (partial text, partial surface cards)
 *
 * All done. This keeps the dependency surface tight and the streaming
 * behaviour observable for the UX team.
 */

import { useCallback, useRef, useState } from 'react';

import {
  parseSurfaceStream,
  type ParsedChunk,
  type SurfaceKind,
} from './surface-parser';
import type { SegmentId } from '@/lib/events/types';

export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SurfacePart {
  kind: SurfaceKind;
  data: unknown;
  /** Stable id for React keys — source index within the message. */
  id: string;
}

export interface AssistantMessagePart {
  /** Free text chunks, ordered. */
  text: string;
  /** Surface cards discovered mid-stream. */
  surfaces: SurfacePart[];
}

export type ChatStatus = 'idle' | 'streaming' | 'error' | 'mock-fallback';

/** Discriminated result of a single `send()` call. */
export type SendResult =
  | { outcome: 'ok'; message: AssistantMessagePart }
  | { outcome: 'mock-fallback'; reason: string }
  | { outcome: 'error'; reason: string }
  | { outcome: 'aborted' };

export interface UseChatStreamResult {
  status: ChatStatus;
  error: string | null;
  /** Partial assistant message currently being streamed (empty when idle). */
  streaming: AssistantMessagePart;
  /** Start a stream. Resolves with a tagged outcome. */
  send: (opts: {
    messages: ChatTurnMessage[];
    segmentId?: SegmentId;
  }) => Promise<SendResult>;
  /** Cancel the in-flight request (if any). */
  abort: () => void;
}

export function useChatStream(): UseChatStreamResult {
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<AssistantMessagePart>({
    text: '',
    surfaces: [],
  });
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(
    async (opts: {
      messages: ChatTurnMessage[];
      segmentId?: SegmentId;
    }): Promise<SendResult> => {
      // Tear down any in-flight request.
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;

      setStatus('streaming');
      setError(null);
      setStreaming({ text: '', surfaces: [] });

      let text = '';
      const surfaces: SurfacePart[] = [];

      try {
        const res = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: opts.messages,
            segmentId: opts.segmentId,
          }),
          signal: ctl.signal,
        });

        if (res.status === 503) {
          // No API key configured — signal fallback to caller.
          let detail = 'Anthropic-Key fehlt';
          try {
            const body: unknown = await res.json();
            if (
              body &&
              typeof body === 'object' &&
              'error' in body &&
              typeof (body as { error: unknown }).error === 'string'
            ) {
              detail = (body as { error: string }).error;
            }
          } catch {
            // ignore parse error
          }
          setStatus('mock-fallback');
          setError(detail);
          return { outcome: 'mock-fallback', reason: detail };
        }

        if (!res.ok || !res.body) {
          let detail = `HTTP ${res.status}`;
          try {
            const body: unknown = await res.json();
            if (
              body &&
              typeof body === 'object' &&
              'error' in body &&
              typeof (body as { error: unknown }).error === 'string'
            ) {
              detail = (body as { error: string }).error;
            }
          } catch {
            // ignore parse error
          }
          throw new Error(detail);
        }

        const reader = res.body
          .pipeThrough(new TextDecoderStream())
          .getReader();

        const iter: AsyncIterable<string> = {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<string>> {
                const { value, done } = await reader.read();
                if (done) return { value: undefined, done: true };
                return { value, done: false };
              },
              async return(): Promise<IteratorResult<string>> {
                try {
                  await reader.cancel();
                } catch {
                  // ignore
                }
                return { value: undefined, done: true };
              },
            };
          },
        };

        let surfaceCount = 0;
        for await (const chunk of parseSurfaceStream(iter) as AsyncIterable<ParsedChunk>) {
          if (ctl.signal.aborted) break;
          if (chunk.type === 'text') {
            text += chunk.content;
            setStreaming({ text, surfaces: [...surfaces] });
          } else {
            const sp: SurfacePart = {
              kind: chunk.kind,
              data: chunk.data,
              id: `s-${surfaceCount}`,
            };
            surfaceCount += 1;
            surfaces.push(sp);
            setStreaming({ text, surfaces: [...surfaces] });
          }
        }

        setStatus('idle');
        abortRef.current = null;
        return { outcome: 'ok', message: { text, surfaces } };
      } catch (err) {
        if (ctl.signal.aborted) {
          setStatus('idle');
          return { outcome: 'aborted' };
        }
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus('error');
        abortRef.current = null;
        return { outcome: 'error', reason: msg };
      }
    },
    [],
  );

  return { status, error, streaming, send, abort };
}
