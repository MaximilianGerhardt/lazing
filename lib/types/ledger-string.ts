/**
 * lib/types/ledger-string.ts — Brand-Typ für N1 (Detail-Preservation).
 *
 * ## Was ist LedgerString?
 *
 * `LedgerString` ist ein nominal-getypter Wrapper um `string`, der signalisiert
 * dass der Inhalt **verbatim** ist — d.h. er stammt direkt aus dem Chat-Ledger,
 * einem Evidence-Record oder einem Detail-Ledger-Eintrag und darf unter keinen
 * Umständen gekürzt, zusammengefasst oder anderweitig verändert werden.
 *
 * ## N1 — Detail-Preservation (non-negotiable operating constraint)
 *
 * Operating Constraint N1 des Lazing Swarm Runtime lautet:
 *   "Detail preservation is architectural, not a prompt cap."
 *
 * Das bedeutet konkret:
 *   - Kein Code-Pfad darf `.slice()`, `.substring()` oder `.substr()` auf
 *     Ledger-Content-Felder (`contentFull`, `content_full`, `detailBody`,
 *     `detail_body`, `ledgerContent`) aufrufen.
 *   - Diese Einschränkung ist in `eslint.config.mjs` als `no-restricted-syntax`
 *     Regel maschinell durchgesetzt — der Lint schlägt fehl bevor schlechter
 *     Code in main landet.
 *   - `LedgerString`-Werte müssen **immer vollständig** an die nächste Schicht
 *     weitergegeben werden. Truncation ist ausschließlich in der Render-/UI-
 *     Schicht erlaubt und muss dort explizit als CSS (`text-overflow: ellipsis`)
 *     oder als bewusste UI-Entscheidung gekennzeichnet sein — niemals im
 *     Service- oder Repository-Layer.
 *
 * ## Verwendung
 *
 * ```typescript
 * import { asLedgerString, type LedgerString } from '@/lib/types/ledger-string';
 *
 * // Im Service-Layer: einmalig beim Lesen aus der DB branden
 * const content: LedgerString = asLedgerString(row.content_full);
 *
 * // Weitergabe: immer als LedgerString, nie aufteilen
 * function processEntry(content: LedgerString): void {
 *   // OK: string-Operationen die keinen Inhalt entfernen
 *   const trimmed = content.trim(); // trim() ist erlaubt — kürzt keinen Inhalt
 *   const upper = content.toUpperCase(); // erlaubt
 *
 *   // VERBOTEN (Lint-Error):
 *   // content.slice(0, 200)      <- N1-Violation
 *   // content.substring(0, 100)  <- N1-Violation
 *   // content.substr(0, 50)      <- N1-Violation
 * }
 * ```
 *
 * ## Warum unique symbol?
 *
 * TypeScript's structural typing würde einen einfachen `{ __ledger: true }`
 * brand zulassen, der mit jedem passenden Objekt kompatibel ist. Ein
 * `unique symbol` erzeugt eine nicht-exportierbare, nicht-fälschbare Identität —
 * nur `asLedgerString()` kann einen `LedgerString` erzeugen.
 *
 * @see {@link https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html}
 * @see eslint.config.mjs — no-restricted-syntax N1-Guard
 * @see lib/chat/ledger.ts — kanonischer Insert-Pfad (appendLedgerRow)
 * @see db/schema/chat_ledger.ts — contentFull ist N1-verbatim
 */

/**
 * Nominal string brand für verbatim Ledger-Content.
 *
 * Werte dieses Typs stammen aus append-only Ledger-Tabellen (chat_ledger,
 * workstream_detail_ledger, workstream_evidence) und repräsentieren den
 * unveränderten, vollständigen Originalinhalt. Sie dürfen weder gekürzt
 * noch paraphrasiert werden bevor sie persistiert oder an andere
 * Service-Layer weitergegeben werden.
 */
export type LedgerString = string & { readonly __ledger: unique symbol };

/**
 * Markiert einen `string`-Wert als verifizierten Ledger-Content.
 *
 * NUR aufrufen wenn der String aus einem authorisierten Ledger-Read-Pfad
 * stammt (d.h. Service-Layer, nicht direkte DB-Rohabrufe aus API-Routes).
 * Der Type Cast ist bewusst — er dokumentiert die Herkunft des Strings.
 *
 * @param s - Verbatim string aus einem Ledger-Record. Muss ungekürzt sein.
 * @returns Der gleiche String, typisiert als LedgerString.
 */
export function asLedgerString(s: string): LedgerString {
  return s as LedgerString;
}
