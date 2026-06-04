/**
 * ENG-01/02 — Engine Card types.
 *
 * Engine types map 1:1 to CSS accent classes in
 * `app/components.css` (section K · ENG):
 *
 *   claude → .cl  (e-claude accent + glow)
 *   codex  → .cx  (e-codex accent + glow)
 *   local  → .lo  (e-local accent + glow)
 */
export type EngineType = 'claude' | 'codex' | 'local';

/**
 * Runtime status of the engine.
 *
 *   running → default state; status dot pulses (CSS anim.)
 *   idle    → adds `.idle` to .st → no pulse, dimmed colour.
 */
export type EngineStatus = 'running' | 'idle';
