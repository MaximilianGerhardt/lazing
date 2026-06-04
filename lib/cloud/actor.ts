/**
 * Actor resolver for cloud-API audit (Phase ORG SP-2 — refactor 2026-04-27).
 *
 * Before Phase ORG: hardcoded `user:max` as fallback.
 * Phase ORG: delegates to `lib/security/subject.ts` — that is the
 * single source of truth for subject resolution. `currentActor()` reads
 * the `x-lazyos-subject` header set by the middleware.
 */

import { currentActor, type RequestLike } from "@/lib/security/subject";

export function resolveActor(req: RequestLike): string {
  return currentActor(req);
}
