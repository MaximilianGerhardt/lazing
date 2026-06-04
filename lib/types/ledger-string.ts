/**
 * lib/types/ledger-string.ts — brand type for N1 (detail preservation).
 *
 * ## What is LedgerString?
 *
 * `LedgerString` is a nominally-typed wrapper around `string` that signals
 * the content is **verbatim** — i.e. it comes directly from the chat ledger,
 * an evidence record or a detail-ledger entry and must under no
 * circumstances be shortened, summarized or otherwise altered.
 *
 * ## N1 — detail preservation (non-negotiable operating constraint)
 *
 * Operating Constraint N1 of the Lazing Swarm Runtime reads:
 *   "Detail preservation is architectural, not a prompt cap."
 *
 * Concretely this means:
 *   - No code path may call `.slice()`, `.substring()` or `.substr()` on
 *     ledger content fields (`contentFull`, `content_full`, `detailBody`,
 *     `detail_body`, `ledgerContent`).
 *   - This restriction is enforced mechanically in `eslint.config.mjs` as a
 *     `no-restricted-syntax` rule — the lint fails before bad
 *     code lands in main.
 *   - `LedgerString` values must **always** be passed on **in full** to the next layer.
 *     Truncation is allowed exclusively in the render/UI
 *     layer and must be marked there explicitly as CSS (`text-overflow: ellipsis`)
 *     or as a deliberate UI decision — never in the
 *     service or repository layer.
 *
 * ## Usage
 *
 * ```typescript
 * import { asLedgerString, type LedgerString } from '@/lib/types/ledger-string';
 *
 * // In the service layer: brand once when reading from the DB
 * const content: LedgerString = asLedgerString(row.content_full);
 *
 * // Passing on: always as a LedgerString, never split
 * function processEntry(content: LedgerString): void {
 *   // OK: string operations that don't remove content
 *   const trimmed = content.trim(); // trim() is allowed — removes no content
 *   const upper = content.toUpperCase(); // allowed
 *
 *   // FORBIDDEN (lint error):
 *   // content.slice(0, 200)      <- N1 violation
 *   // content.substring(0, 100)  <- N1 violation
 *   // content.substr(0, 50)      <- N1 violation
 * }
 * ```
 *
 * ## Why a unique symbol?
 *
 * TypeScript's structural typing would allow a simple `{ __ledger: true }`
 * brand that is compatible with any matching object. A
 * `unique symbol` creates a non-exportable, non-forgeable identity —
 * only `asLedgerString()` can create a `LedgerString`.
 *
 * @see {@link https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html}
 * @see eslint.config.mjs — no-restricted-syntax N1 guard
 * @see lib/chat/ledger.ts — canonical insert path (appendLedgerRow)
 * @see db/schema/chat_ledger.ts — contentFull is N1-verbatim
 */

/**
 * Nominal string brand for verbatim ledger content.
 *
 * Values of this type come from append-only ledger tables (chat_ledger,
 * workstream_detail_ledger, workstream_evidence) and represent the
 * unaltered, complete original content. They may neither be shortened
 * nor paraphrased before they are persisted or passed on to other
 * service layers.
 */
export type LedgerString = string & { readonly __ledger: unique symbol };

/**
 * Marks a `string` value as verified ledger content.
 *
 * ONLY call when the string comes from an authorized ledger read path
 * (i.e. the service layer, not direct raw DB fetches from API routes).
 * The type cast is deliberate — it documents the origin of the string.
 *
 * @param s - Verbatim string from a ledger record. Must be unshortened.
 * @returns The same string, typed as a LedgerString.
 */
export function asLedgerString(s: string): LedgerString {
  return s as LedgerString;
}
