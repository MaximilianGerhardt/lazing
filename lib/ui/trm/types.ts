/**
 * TRM-01 — Terminal Block types.
 *
 * Line-level tags map 1:1 to CSS span classes in
 * `app/components.css` (section J · TRM):
 *
 *   prompt → .p   (path, e.g. "~/lazyos", accent green)
 *   host   → .h   (user@host, private-accent)
 *   dim    → .o   (muted / output noise)
 *   error  → .e   (danger red)
 *   ok     → .ok  (success green)
 *   claude → .cl  (engine-claude accent)
 *   codex  → .cx  (engine-codex accent)
 *   default → (no class — inherits .term base color)
 */
export type TermLineLevel =
  | 'default'
  | 'prompt'
  | 'host'
  | 'dim'
  | 'error'
  | 'ok'
  | 'claude'
  | 'codex';

/**
 * A single span inside a terminal line. Allows mixed
 * colouring on one line — e.g.
 *   [{text:'nick@vps', level:'host'}, {text:':'},
 *    {text:'~/lazyos', level:'prompt'},
 *    {text:'$ claude-code status'}]
 */
export interface TermSpan {
  text: string;
  level?: TermLineLevel;
}

/**
 * One terminal line.
 *
 * Either `spans` (for mixed colouring) OR `text` (simple
 * single-level line) must be supplied. If both are given,
 * `spans` wins and `text` is ignored.
 *
 * `level` applies to the line as a whole when `text` is used.
 * `cursor` appends a blinking caret (.cu) at the end of the
 * line — typically on the last, "live" prompt line only.
 */
export interface TermLine {
  level?: TermLineLevel;
  spans?: TermSpan[];
  text?: string;
  cursor?: boolean;
}
