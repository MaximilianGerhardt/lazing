/**
 * Subject-Resolver — Phase ORG SP-2 (2026-04-27).
 *
 * Single source of truth for **who** is currently making a request. Before
 * Phase ORG, the subject was hardcoded `user:max` in >12 places in the code;
 * here that is replaced by a header-based abstraction.
 *
 * Trust anchor: the `x-lazyos-subject` request header. The edge middleware
 * deletes `x-lazyos-subject`, `x-lazyos-user-id` and `x-lazyos-auth`
 * UNCONDITIONALLY at the start of every request (step 0, before any branch —
 * even before the public-path return). Only AFTER that do the
 * authenticated branches (bridge / agent / verified-session-cookie)
 * set the header to the cryptographically verified value. Handlers may
 * therefore read the header as truth — no client-sent value
 * can ever reach a handler that was not set by an auth branch.
 *
 * Subject format:
 *   `user:<ulid>`            → authenticated user via cookie
 *   `agent:cli`              → lazyos-cli with a valid bearer token
 *   `agent:chat`             → workspace session agent (started internally)
 *   `system:bridge`          → VPS bridge (Vercel→VPS service-to-service)
 *   `system`                 → cron jobs, boot init, backfill scripts
 *   `anon-share-token:<id>`  → external share-link sessions (Phase N)
 *
 * Migration:
 *   `user:max-bootstrap` is the ULID gap for legacy cookies before the
 *   SP-9 backfill. After the backfill, `BOOTSTRAP_USER_ID` is replaced by the
 *   real ULID — all existing cookies stay valid
 *   as long as the legacy HMAC verifies.
 */

import { BOOTSTRAP_USER_ID } from "./session";

export interface RequestLike {
  headers: { get(name: string): string | null };
}

export type Subject =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "system"; systemId: string }
  | { kind: "anon-share-token"; tokenId: string }
  | { kind: "anon" };

/** Format check. Whitelist of allowed kind prefixes. */
const SUBJECT_PATTERN = /^(user|agent|system|anon-share-token):[a-z0-9_:.\-]{1,64}$/i;

/**
 * Reads the set `x-lazyos-subject` from the request header and
 * parses it. On a missing/invalid value: `{kind:"anon"}`.
 *
 * Never callable without the edge-middleware preamble — all authenticated
 * routes always have the header.
 */
export function currentSubject(req: RequestLike): Subject {
  const raw = req.headers.get("x-lazyos-subject");
  if (!raw) return { kind: "anon" };
  if (!SUBJECT_PATTERN.test(raw)) return { kind: "anon" };
  const colon = raw.indexOf(":");
  const kind = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  switch (kind) {
    case "user":
      return { kind: "user", userId: id };
    case "agent":
      return { kind: "agent", agentId: id };
    case "system":
      return { kind: "system", systemId: id };
    case "anon-share-token":
      return { kind: "anon-share-token", tokenId: id };
    default:
      return { kind: "anon" };
  }
}

/**
 * Format helper for the audit log and legacy code paths that expect a single
 * string. Identical to the header value.
 */
export function actorString(subject: Subject): string {
  switch (subject.kind) {
    case "user":
      return `user:${subject.userId}`;
    case "agent":
      return `agent:${subject.agentId}`;
    case "system":
      return `system:${subject.systemId}`;
    case "anon-share-token":
      return `anon-share-token:${subject.tokenId}`;
    case "anon":
      return "anon";
  }
}

/**
 * Convenience: read the audit-actor string directly from the request.
 * Replaces hardcoded `user:max` everywhere.
 */
export function currentActor(req: RequestLike): string {
  return actorString(currentSubject(req));
}

/**
 * Convenience: returns the userId if the subject is a user, otherwise null.
 * Useful for repo lookups (`users.findById`).
 */
export function currentUserId(req: RequestLike): string | null {
  const s = currentSubject(req);
  return s.kind === "user" ? s.userId : null;
}

export { BOOTSTRAP_USER_ID };
