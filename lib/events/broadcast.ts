/**
 * In-memory event broadcast for SSE listeners.
 *
 * Singleton EventTarget per Lambda instance. `emitEvent()` calls `publish()`,
 * `getEventStream()` subscribes via `subscribe()`.
 *
 * Vercel context: each Lambda instance has its own in-memory state. A
 * browser client connects to ONE instance; events written on ANOTHER
 * instance do not reach it via broadcast. For the
 * 1-user MVP this is acceptable: on reconnect the browser can backfill via
 * `sinceId` from the event log (persistence = source of truth).
 *
 * Phase 6 (multi-instance): Redis Pub/Sub or Postgres `LISTEN/NOTIFY`.
 */

import type { LazyEvent } from "./types";

type Listener = (event: LazyEvent) => void;

class EventBroadcast {
  private listeners = new Set<Listener>();

  publish(event: LazyEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let a dead listener break the publisher.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get size(): number {
    return this.listeners.size;
  }
}

// Module singleton. In the Next.js Node runtime, module state persists
// across requests as long as the Lambda stays warm.
const globalForBroadcast = globalThis as unknown as {
  __lazyosBroadcast?: EventBroadcast;
};

export const broadcast: EventBroadcast =
  globalForBroadcast.__lazyosBroadcast ?? new EventBroadcast();

if (!globalForBroadcast.__lazyosBroadcast) {
  globalForBroadcast.__lazyosBroadcast = broadcast;
}
