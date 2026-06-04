'use client';

/**
 * SurfaceHelperAffordance — manifestation-layer helper (owner request 2026-05-30)
 * ----------------------------------------------------------------------------
 * Owner request (near-verbatim): „Surface/Manifestation-Layer-Helper oder so, der
 * ggf. korrigiert oder wenn etwas nicht visualisiert wird, dass man direkt neues
 * Surface generieren drücken kann mit einem Icon Magic-Stift was weiß ich?!"
 *
 * This component appears EXACTLY where a surface is NOT visualized
 * correctly — the three real non-render cases in the manifestation
 * layer are:
 *
 *   (a) `renderSurface(kind, data)` returns `null` (payload incomplete /
 *       empty / a not-yet-implemented kind like 'onboarding-progress').
 *   (b) Parse error: the surface block contained invalid JSON
 *       (surface-parser.ts / surface-text-render.ts catch this and
 *       pass the raw tag text through).
 *   (c) Unknown kind: a hallucinated `<surface:foo>` tag that the parser
 *       did not whitelist.
 *
 * Instead of printing the bare tag text in gray (old else branch in
 * surface-text-render.tsx), the affordance offers the owner a Magic-Wand
 * button "Surface generieren" (and contextually "Korrigieren") that requests
 * a (re-)generation of the surface.
 *
 * This is the seed of the generative-UI vision ([[lazing_surface_philosophy]]:
 * surfaces are built by the AI ITSELF, not picked from a library).
 *
 * ARCHITECTURE — trigger-hook contract (for Agent I / the generative backend part)
 * -----------------------------------------------------------------------------
 * This component provides ONLY the UI affordance + the trigger. The actual
 * surface (re-)generation is built by a parallel agent (I). The
 * bridge is an optional, globally registrable handler:
 *
 *     registerSurfaceRegenHandler(async (req) => { ... })
 *
 * with `req: SurfaceRegenRequest`:
 *     {
 *       reason: 'render-null' | 'parse-error' | 'unknown-kind',
 *       kind: string,          // the (possibly unknown) surface kind
 *       raw: string,           // the raw `<surface:…>…</surface:…>` tag
 *       intent: 'generate' | 'correct',  // which button was clicked
 *     }
 *   → Promise<void> (fire-and-forget; errors are swallowed, fail-soft).
 *
 * FAIL-SOFT: as long as Agent I has registered no handler, the action falls
 * back to `useSurfaceAction().reply(...)` — i.e. the owner click is sent as a
 * normal chat message to the agent ("Bitte generiere/korrigiere dieses Surface
 * neu: …"). This way the affordance works IMMEDIATELY, even before the
 * generative path exists; once I registers a handler, it takes over.
 *
 * Design (Apple-UX, token-only, mobile 390px):
 *   - ≥44px touch target on the primary button (Magic-Wand).
 *   - Token-only via .srf-helper* CSS classes in app/components.css (no
 *     inline hex → lint:hex stays clean).
 *   - One primary action (Jobs/Rams): "Surface generieren". "Korrigieren"
 *     is secondary (only sensible for parse-error/render-null, NOT for
 *     unknown-kind — there is nothing to correct there, only to regenerate).
 *   - Collapsed-by-default detail: the raw tag sits in a <details> for
 *     debugging, not prominent.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import { useSurfaceAction } from './SurfaceActionContext';

/**
 * Inline „Magic-Wand"/sparkles icon (replaces the previous sparkles glyph). 24×24 viewBox,
 * currentColor, 1.6 stroke, round caps — matches the nav-icon family. aria-hidden,
 * because the surrounding spans/buttons already carry a label.
 */
function MagicWandIcon({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      <path d="M6 18 18 6" />
      <path d="M14 4l1.2 2.4L17.6 7.6 15.2 8.8 14 11.2 12.8 8.8 10.4 7.6 12.8 6.4 14 4z" />
      <path d="M5 13l.7 1.5L7.2 15.2 5.7 15.9 5 17.4 4.3 15.9 2.8 15.2 4.3 14.5 5 13z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Trigger-hook contract (Agent I integration point)
// ---------------------------------------------------------------------------

export type SurfaceRegenReason = 'render-null' | 'parse-error' | 'unknown-kind';
export type SurfaceRegenIntent = 'generate' | 'correct';

export interface SurfaceRegenRequest {
  /** Why the surface does not render today. */
  reason: SurfaceRegenReason;
  /** The (possibly unknown / hallucinated) surface kind. */
  kind: string;
  /** The raw `<surface:…>…</surface:…>` tag (load-bearing context for I). */
  raw: string;
  /** Which button was clicked. */
  intent: SurfaceRegenIntent;
}

export type SurfaceRegenHandler = (
  req: SurfaceRegenRequest,
) => void | Promise<void>;

/**
 * Module-global, optional handler. Agent I registers its generative logic
 * here. Deliberately module-global (no React context), so the
 * pure String→ReactNode render path (`renderChatText`) can use it without
 * provider wrapping — exactly as the last-known-good cache is module-global.
 */
let surfaceRegenHandler: SurfaceRegenHandler | null = null;

/**
 * Registers the generative (re-)gen handler. Called by Agent I (e.g. in
 * a client bootstrap / a useEffect in ChatShell). Returns an
 * unregister function.
 */
export function registerSurfaceRegenHandler(
  handler: SurfaceRegenHandler,
): () => void {
  surfaceRegenHandler = handler;
  return () => {
    if (surfaceRegenHandler === handler) surfaceRegenHandler = null;
  };
}

/** For tests / introspection only: is a generative handler registered? */
export function hasSurfaceRegenHandler(): boolean {
  return surfaceRegenHandler !== null;
}

// ---------------------------------------------------------------------------
// Affordance component
// ---------------------------------------------------------------------------

// Apple copy (feed cleanliness 2026-05-30): calm, without "Surface"/"the AI
// meant". A view that could not be built — factual, short.
const REASON_LABEL: Record<SurfaceRegenReason, string> = {
  'render-null': 'Diese Ansicht ließ sich nicht aufbauen.',
  'parse-error': 'Diese Ansicht ließ sich nicht aufbauen.',
  'unknown-kind': 'Diese Ansicht ist noch nicht verfügbar.',
};

const REASON_SUB: Record<SurfaceRegenReason, string> = {
  'render-null': 'Die Daten reichten zum Anzeigen nicht aus.',
  'parse-error': 'Die Daten waren unvollständig.',
  'unknown-kind': 'Lass sie neu aufbauen.',
};

export function SurfaceHelperAffordance({
  reason,
  kind,
  raw,
}: {
  reason: SurfaceRegenReason;
  kind: string;
  raw: string;
}): ReactNode {
  const { reply } = useSurfaceAction();
  const [busy, setBusy] = useState(false);

  // "Korrigieren" only makes sense if there is any (broken) content
  // to correct — i.e. on render-null or parse-error. For an
  // unknown kind there is only "regenerate".
  const showCorrect = reason !== 'unknown-kind';

  async function trigger(intent: SurfaceRegenIntent): Promise<void> {
    if (busy) return;
    setBusy(true);
    const req: SurfaceRegenRequest = { reason, kind, raw, intent };
    try {
      if (surfaceRegenHandler) {
        // Agent-I path (generative).
        await surfaceRegenHandler(req);
      } else {
        // Fail-soft fallback: as a normal chat message to the agent.
        const verb =
          intent === 'correct'
            ? 'Bitte korrigiere dieses Surface, sodass es korrekt angezeigt wird'
            : 'Bitte generiere ein passendes Surface neu (es wird gerade nicht angezeigt)';
        reply(`${verb} (kind="${kind}", grund="${reason}"):\n\n${raw}`);
      }
    } catch {
      // fail-soft — a failed (re-)gen trigger must never crash the chat.
      // The owner can click again.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="srf-helper"
      role="group"
      aria-label={REASON_LABEL[reason]}
      data-test="surface-helper-affordance"
      data-surface-reason={reason}
      data-surface-kind={kind}
    >
      <div className="srf-helper__head">
        <span className="srf-helper__glyph" aria-hidden>
          <MagicWandIcon size={20} />
        </span>
        <div className="srf-helper__copy">
          <div className="srf-helper__title">{REASON_LABEL[reason]}</div>
          <div className="srf-helper__sub">{REASON_SUB[reason]}</div>
        </div>
      </div>

      <div className="srf-helper__actions">
        <button
          type="button"
          className="srf-helper__btn srf-helper__btn--primary press"
          data-test="surface-helper-generate"
          disabled={busy}
          onClick={() => void trigger('generate')}
        >
          <span className="srf-helper__btn-glyph" aria-hidden>
            <MagicWandIcon size={16} />
          </span>
          Surface generieren
        </button>
        {showCorrect ? (
          <button
            type="button"
            className="srf-helper__btn srf-helper__btn--ghost press"
            data-test="surface-helper-correct"
            disabled={busy}
            onClick={() => void trigger('correct')}
          >
            Korrigieren
          </button>
        ) : null}
      </div>

      <details className="srf-helper__raw" data-test="surface-helper-raw">
        <summary className="srf-helper__raw-summary">Rohdaten anzeigen</summary>
        <pre className="srf-helper__raw-pre">{raw}</pre>
      </details>
    </div>
  );
}
