/**
 * degradation-detector — PURE Entscheidung, ob eine Claude-Session rotiert werden
 * soll (degrade→handoff→rotate). Keine I/O, keine DB, kein Date.now() im Kern →
 * erschöpfend unit-testbar (das Test-Gate verlangt Perfektion hier).
 *
 * Hintergrund (Audit 2026-06-03): lazyOS führt EINE Session pro Workspace ewig
 * via --resume weiter; Output degradiert mit der Länge; der einzige Auto-Reset
 * feuerte auf last_result='error' — das FALSCHE Signal. Dieser Detektor liefert
 * die richtigen Signale:
 *   - Turn-Budget überschritten         → Kontext zu lang
 *   - Token-Budget (kumulativ) über      → Kontext zu schwer
 *   - Alter-Budget über                  → Session spannt vermutlich viele Tasks
 *   - last_result='too_many_turns'       → die CLI hat selbst ihr Turn-Cap erreicht
 *   - explizite Task-Grenze (Plan fertig)→ saubere frische Session pro Aufgabe
 *
 * Bewusst NICHT: last_result='error' triggert hier KEINE Rotation — das behandelt
 * der bestehende Self-Heal-Pfad in workspace-session.ts (frische UUID bei korruptem
 * Transcript). Doppelte Behandlung würde sich gegenseitig ins Gehege kommen.
 */

export interface SessionVitals {
  /** Erfolgreiche Turns auf dieser Session. */
  turnCount: number;
  /** Kumulativer Token-Proxy (prompt+output chars/4) über alle Turns. */
  tokenEstimate: number;
  /** Alter der Session in ms (now - createdAt). */
  ageMs: number;
  /** Letztes Ergebnis-Label ('success'|'error'|'aborted'|'too_many_turns'|null). */
  lastResult: string | null;
}

export interface RotationPolicy {
  /** Rotation, sobald turnCount >= maxTurns. */
  maxTurns: number;
  /** Rotation, sobald tokenEstimate >= maxTokens. */
  maxTokens: number;
  /** Rotation, sobald ageMs >= maxAgeMs. */
  maxAgeMs: number;
  /** Mindest-turnCount, damit eine Task-Grenze überhaupt rotiert (eine schon
   *  frische 0-Turn-Session braucht keine Rotation). */
  minTurnsForTaskBoundary: number;
}

export type RotationReason =
  | 'turn-budget'
  | 'token-budget'
  | 'age-budget'
  | 'too-many-turns'
  | 'task-boundary'
  | 'none';

export interface RotationDecision {
  rotate: boolean;
  reason: RotationReason;
  /** Menschlich lesbares Detail fürs Audit/Log. */
  detail: string;
}

/**
 * Defaults — bewusst konservativ (lieber etwas zu früh rotieren als degradierten
 * Output liefern). Alle via ENV überschreibbar; reversibel.
 */
export const DEFAULT_ROTATION_POLICY: RotationPolicy = {
  // PRIMÄRsignale für Degradation = akkumulierter Kontext (Turns + Token-Proxy).
  maxTurns: 40,
  maxTokens: 250_000,
  // Alter ist nur das SCHWACHE Sekundärsignal (eine uralte Session spannt
  // vermutlich unzusammenhängende Tasks + hat ein riesiges Transcript). Bewusst
  // konservativ (7 Tage), um eine legitime mehrtägige aktive Unterhaltung NICHT
  // zu unterbrechen — die echte Degradation fangen Turn-/Token-Budget ab.
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 Tage
  minTurnsForTaskBoundary: 1,
};

/** Policy aus ENV lesen (fail-soft auf Defaults). Nicht im PURE-Kern aufrufen. */
export function rotationPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RotationPolicy {
  const num = (v: string | undefined, d: number): number => {
    if (!v) return d;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxTurns: num(env.LAZYOS_SESSION_MAX_TURNS, DEFAULT_ROTATION_POLICY.maxTurns),
    maxTokens: num(env.LAZYOS_SESSION_MAX_TOKENS, DEFAULT_ROTATION_POLICY.maxTokens),
    maxAgeMs: num(env.LAZYOS_SESSION_MAX_AGE_MS, DEFAULT_ROTATION_POLICY.maxAgeMs),
    minTurnsForTaskBoundary: DEFAULT_ROTATION_POLICY.minTurnsForTaskBoundary,
  };
}

/** Ob Auto-Rotation überhaupt aktiv ist (ENV-Kill-Switch, Default an). */
export function rotationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.LAZYOS_SESSION_ROTATION !== '0';
}

/**
 * Der Kern: PURE. `taskBoundary=true` bedeutet "ein Plan/Task ist gerade sauber
 * abgeschlossen" → frische Session für die nächste Aufgabe (nur wenn die Session
 * bereits gearbeitet hat). Sonst entscheiden die Degradations-Budgets.
 *
 * Reihenfolge der Gründe ist deterministisch (Task-Grenze zuerst, dann das am
 * deutlichsten überschrittene Budget) — wichtig für stabile Tests + Audit.
 */
export function assessRotation(
  v: SessionVitals,
  taskBoundary: boolean,
  policy: RotationPolicy = DEFAULT_ROTATION_POLICY,
): RotationDecision {
  // Explizite Task-Grenze gewinnt — aber nur wenn die Session schon Turns hatte.
  if (taskBoundary && v.turnCount >= policy.minTurnsForTaskBoundary) {
    return {
      rotate: true,
      reason: 'task-boundary',
      detail: `Task abgeschlossen nach ${v.turnCount} Turns → frische Session`,
    };
  }

  // Die CLI hat ihr eigenes Turn-Cap erreicht → klares Degradationssignal.
  if (v.lastResult === 'too_many_turns') {
    return {
      rotate: true,
      reason: 'too-many-turns',
      detail: 'last_result=too_many_turns → CLI-Turn-Cap erreicht',
    };
  }

  if (v.tokenEstimate >= policy.maxTokens) {
    return {
      rotate: true,
      reason: 'token-budget',
      detail: `tokenEstimate ${v.tokenEstimate} >= ${policy.maxTokens}`,
    };
  }
  if (v.turnCount >= policy.maxTurns) {
    return {
      rotate: true,
      reason: 'turn-budget',
      detail: `turnCount ${v.turnCount} >= ${policy.maxTurns}`,
    };
  }
  if (v.ageMs >= policy.maxAgeMs) {
    return {
      rotate: true,
      reason: 'age-budget',
      detail: `ageMs ${v.ageMs} >= ${policy.maxAgeMs}`,
    };
  }

  return { rotate: false, reason: 'none', detail: 'within budgets' };
}

/** Token-Schätzung aus Zeichenlängen (≈ chars/4), defensiv geclamped. */
export function estimateTokens(promptChars: number, outputBytes: number): number {
  const c = Math.max(0, promptChars) + Math.max(0, outputBytes);
  return Math.ceil(c / 4);
}

/**
 * Alter-Baseline für das Age-Budget: seit der LETZTEN Rotation (`rotatedAt`),
 * sonst seit Erstellung (`createdAt`).
 *
 * KRITISCH (Review CRIT-1, 2026-06-03): Die Rotation setzt turn_count/
 * token_estimate zurück, aber `created_at` bleibt unveränderlich. Würde das
 * Age-Budget weiter gegen `created_at` rechnen, rotierte eine >maxAge alte
 * Session JEDEN Turn neu (Age bleibt ja > maxAge) → selbst-perpetuierende
 * Rotations-Schleife, die jedes Mal den Handoff neu schreibt + das gerade
 * resumte Transcript verwirft. Gegen `rotatedAt` zu rechnen setzt das Alter mit
 * jeder Rotation zurück (frische Session ⇒ frisches Alter), `created_at` bleibt
 * als echte Provenance erhalten.
 */
export function effectiveAgeMs(
  createdAt: number,
  rotatedAt: number | null | undefined,
  now: number,
): number {
  return Math.max(0, now - (rotatedAt ?? createdAt));
}
