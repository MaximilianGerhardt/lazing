'use client';

/**
 * ActionDeck — Slice 2 (2026-05-30, Apple-UX surface rework).
 *
 * THE ONE pinned bottom region above the composer. Does NOT replace any
 * existing pinning, but WRAPS today's OpenQuestionsPill: at the same
 * DOM position (`composerWrapStyle`, outside the scroll container), with
 * the same flexbox pinning geometry. There is still EXACTLY ONE pinned
 * region — never two competing things.
 *
 * Owner finding #1 (verbatim):
 *   „Plan-Synthese fertig + Entscheidung benötigt gleichzeitig → die
 *    Entscheidung geht komplett unter → komplett irreführend. Sowas muss
 *    immer unten über den Chat angepinnt sein, so wie mit den Fragen."
 *
 * The source of truth is the DB projection (`useWorkspaceState` →
 * `selectPinnedItem`), NOT the rendered history. `selectPinnedItem`
 * mirrors `deriveNextAllowedUserInput`: gate > open question > info > null.
 *
 * Renders EXACTLY ONE variant depending on priority:
 *   (a) Gate → quiet card „◆ Entscheidung benötigt · <headline>" collapsed;
 *       Expand shows the primary action (≥44px). The ACTION is delegated to
 *       the parent (`onGateAction`) — the same submit path as the
 *       stream card, NO second routing in the deck (just as OpenQuestionsPill
 *       delegates its submit to ChatShell). Accent --a-warn, resp.
 *       --a-danger for live-warn.
 *   (b) Question → the EXISTING ChatOpenQuestionsPill 1:1 (back-compat —
 *       all features: nav, n/total, options, dismiss, ask-but-proceed).
 *   (c) Info → a narrow non-blocking „läuft" line.
 *   (d) null → the region renders nothing for the deck part.
 *
 * IMPORTANT (PRESERVED): When the projection does not (yet) know a gate, but
 * the history already has open questions, the pill MUST still appear. The
 * deck therefore does not decide on the projection alone whether the pill
 * renders — it renders the pill whenever `pillQuestions` is not empty
 * AND no gate takes precedence. This keeps today's history-driven
 * question path fully intact, even when the projection route is sometimes
 * slower than the live stream.
 *
 * The gate surface stays as a TRAIL/record in the stream (N8) — only the
 * primary action is mirrored here. Once answered via DB (next projection),
 * the gate disappears from `blockingGates` → the deck slides to the next
 * priority.
 */

import { useState } from 'react';

import { IconChevronDown } from '../nav/icons';
import { ChatOpenQuestionsPill } from './ChatOpenQuestionsPill';
import type { ChatOpenQuestionsPillProps } from './ChatOpenQuestionsPill';
import type { PinnedItem } from './useWorkspaceState';
import type {
  BlockingGateState,
  BlockingGateKind,
  GateOption,
} from '../projection/types';

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ───────────────────────────────────────────────────────────────────────────
// Gate action routing (SINGLE SUBMIT PATH) — pure + DOM-tested.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per gate kind: selector of the stream card · the primary action button in it ·
 * whether a secret is needed (then do NOT auto-click, only focus — Vault
 * rule, the secret NEVER lands in the deck).
 *
 * BLOCKER 1 (Critic, 2026-05-30): the earlier map `surface-${kind}` only hit
 * live-warn. human-decision renders as `surface-decision-brief`,
 * credential-request/connector-call-preview had no `data-test` at all → that
 * was a silent no-op. This map is the corrected, complete source.
 */
export const GATE_ACTION_MAP: Record<
  BlockingGateKind,
  { card: string; action: string | null; secret: boolean }
> = {
  'live-warn': {
    card: '[data-test="surface-live-warn"]',
    action: '[data-test="live-warn-ack-btn"]',
    secret: false,
  },
  'human-decision': {
    card: '[data-test="surface-decision-brief"]',
    action: '[data-test="decision-brief-option"][data-recommended="true"]',
    secret: false,
  },
  'connector-call-preview': {
    card: '[data-test="surface-connector-call-preview"]',
    action: '[data-test="connector-call-approve-btn"]',
    secret: false,
  },
  'credential-request': {
    card: '[data-test="surface-credential-request"]',
    action: null, // Secret → only focus.
    secret: true,
  },
  'counter-evidence': {
    card: '[data-test="surface-counter-evidence"]',
    action: null, // pure evidence card.
    secret: false,
  },
  // F18 (2026-05-30): the pinned decision/quickchoice. The deck renders the
  // options itself; selecting an option clicks the REAL button of the in-feed
  // decision card (single submit path, no second fetch). Default `action`
  // (without a specific option) → the recommended/primary option of the card.
  decision: {
    card: '[data-test="surface-decision"]',
    action: '[data-test="surface-decision-option"][data-recommended="true"]',
    secret: false,
  },
};

/**
 * F18 — selector for ONE specific option of a pinned decision card. The
 * deck uses it to click the REAL in-feed button (no second fetch) → exactly the
 * same reply(label) submit path as a direct click on the card.
 */
function decisionOptionSelector(optionId: string): string {
  // Attribute selector with escaped value (option IDs are app-generated, usually
  // simple slugs — JSON.stringify quotes defensively for CSS attr matching).
  return `[data-test="surface-decision-option"][data-option-id=${JSON.stringify(optionId)}]`;
}

export type GateActionOutcome =
  | 'clicked' // primary card button was triggered programmatically (single POST)
  | 'focused' // secret card: input focused, NOT clicked
  | 'scrolled' // made visible, but no primary action (counter-evidence)
  | 'missing'; // card not (yet) in the DOM → caller shows visible feedback

/**
 * Runs the primary gate action DIRECTLY via the associated stream card —
 * EXACTLY ONE POST path (Critic point 3): the deck never builds a second fetch,
 * it clicks the real button of the card. For secret gates it only focuses.
 *
 * Pure DOM effect (no React) → unit-testable against an injected
 * `root` (default: document). Fail-soft on missing DOM (SSR) → 'missing'.
 */
export function executeGateAction(
  gate: BlockingGateState,
  root?: Document | HTMLElement,
  /**
   * F18: for kind='decision', optionally the ID of the chosen option. Set →
   * the deck clicks EXACTLY this option of the in-feed decision card; missing →
   * the recommended/primary option (entry.action). This keeps it ONE submit path
   * (click on the real card button), whether primary or list option.
   */
  optionId?: string,
): GateActionOutcome {
  const doc: Document | HTMLElement | null =
    root ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return 'missing';

  const entry = GATE_ACTION_MAP[gate.kind] ?? {
    card: `[data-test="surface-${gate.kind}"]`,
    action: null,
    secret: false,
  };

  const cardNodes = doc.querySelectorAll<HTMLElement>(entry.card);
  const card = cardNodes.length > 0 ? cardNodes[cardNodes.length - 1]! : null;
  if (!card) return 'missing';

  if (typeof card.scrollIntoView === 'function') {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  card.setAttribute('data-action-deck-focus', 'true');
  if (typeof window !== 'undefined') {
    window.setTimeout(() => card.removeAttribute('data-action-deck-focus'), 1600);
  }

  if (entry.secret) {
    const input = card.querySelector<HTMLInputElement>('input[type="password"]');
    if (input && typeof input.focus === 'function') input.focus();
    return 'focused';
  }

  // F18: targeted option (list selection) OR the recommended primary action.
  const actionSel =
    gate.kind === 'decision' && typeof optionId === 'string' && optionId.length > 0
      ? decisionOptionSelector(optionId)
      : entry.action;

  if (actionSel) {
    const btn = card.querySelector<HTMLButtonElement>(actionSel);
    if (btn && !btn.disabled) {
      btn.click();
      return 'clicked';
    }
    return 'missing';
  }

  return 'scrolled';
}

// ───────────────────────────────────────────────────────────────────────────
// Gate vocabulary → human-readable label + primary action text (verbatim
// description stays N1-preserved as a sub-line).
// ───────────────────────────────────────────────────────────────────────────

interface GateCopy {
  /** Kicker label (visible while collapsed). */
  kicker: string;
  /** Primary action button text (expanded). */
  cta: string;
  /** true → danger accent (--a-danger), otherwise warn accent (--a-warn). */
  danger: boolean;
}

export function gateCopy(kind: BlockingGateKind): GateCopy {
  switch (kind) {
    case 'live-warn':
      // Owner spec: live-warn is the sharpest level → danger accent.
      return { kicker: 'LIVE-Mode bestätigen', cta: 'Ansehen & bestätigen', danger: true };
    case 'credential-request':
      return { kicker: 'Zugang benötigt', cta: 'Zugang eingeben', danger: false };
    case 'connector-call-preview':
      return { kicker: 'Live-Call freigeben', cta: 'Call prüfen', danger: false };
    case 'counter-evidence':
      return { kicker: 'Gegenbeleg prüfen', cta: 'Gegenbeleg ansehen', danger: false };
    case 'human-decision':
      return { kicker: 'Entscheidung benötigt', cta: 'Entscheiden', danger: false };
    case 'decision':
      // F18: the pinned decision/quickchoice. Kicker = owner vocabulary
      // („Entscheidung benötigt"), CTA = the recommended primary option (the
      // deck overrides the CTA text with the verbatim label of the primary option).
      return { kicker: 'Entscheidung benötigt', cta: 'Empfohlene Option', danger: false };
    default: {
      // Exhaustive — new gate kinds must be added here.
      const _exhaustive: never = kind;
      void _exhaustive;
      return { kicker: 'Entscheidung benötigt', cta: 'Ansehen', danger: false };
    }
  }
}

/**
 * A short headline for the gate. Prefers the verbatim description
 * from the payload (N1); otherwise falls back to the kicker label. NO .slice —
 * CSS clamps the display (line-clamp), the truth text stays in the DOM.
 */
export function gateHeadline(gate: BlockingGateState): string {
  const d = typeof gate.description === 'string' ? gate.description.trim() : '';
  if (d.length > 0) return d;
  return gateCopy(gate.kind).kicker;
}

// ───────────────────────────────────────────────────────────────────────────
// Gate card (collapsed/expand) — token-only, all colors via CSS classes.
// ───────────────────────────────────────────────────────────────────────────

export interface ActionDeckGateProps {
  gate: BlockingGateState;
  /**
   * Primary action → delegated to the parent (single submit path). The parent
   * (ChatShell) owns the ONE action path to the stream card / to the POST
   * handler — the deck does NOT route itself. Mirrors the delegation model
   * of OpenQuestionsPill (`onSubmitAll` lives in the parent).
   *
   * F18: for kind='decision', the deck can pass along a concrete option
   * (second argument). The parent forwards it to `executeGateAction(gate, root,
   * option.id)` — there the REAL in-feed option button is clicked
   * (no second fetch). Without an option (old callers) → recommended primary action.
   */
  onGateAction: (gate: BlockingGateState, option?: GateOption) => void;
}

/**
 * F18 — picks the recommended primary option (exactly one; `extractGateOptions`
 * guarantees that) or the first as a fallback. Returns undefined when the
 * decision carries no options (then the deck renders like a generic gate).
 */
function primaryOption(gate: BlockingGateState): GateOption | undefined {
  if (!Array.isArray(gate.options) || gate.options.length === 0) return undefined;
  return gate.options.find((o) => o.recommended) ?? gate.options[0];
}

function ActionDeckGate({ gate, onGateAction }: ActionDeckGateProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const copy = gateCopy(gate.kind);
  const headline = gateHeadline(gate);
  const accentClass = copy.danger ? 'action-deck-gate--danger' : 'action-deck-gate--warn';

  // F18: a pinned decision with options renders the options + ONE
  // recommended primary action (filled/accent) + a quiet list. Free text stays
  // possible via the composer (the deck does not block input).
  const isDecision = gate.kind === 'decision';
  const primary = isDecision ? primaryOption(gate) : undefined;
  const secondary: GateOption[] =
    isDecision && Array.isArray(gate.options)
      ? gate.options.filter((o) => o !== primary)
      : [];

  // Collapsed: a quiet line. ◆ + kicker + headline + chevron. ≥44px hit.
  if (!expanded) {
    return (
      <div className={cx('action-deck-gate', 'action-deck-gate--collapsed', accentClass)}>
        <button
          type="button"
          className="action-deck-gate-bar"
          data-test="action-deck-gate"
          data-gate-kind={gate.kind}
          data-state="collapsed"
          aria-expanded={false}
          aria-label={`${copy.kicker}: ${headline} — ausklappen`}
          onClick={() => setExpanded(true)}
        >
          <span className="action-deck-gate-glyph" aria-hidden="true">
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3l9 9-9 9-9-9 9-9z" />
            </svg>
          </span>
          <span className="action-deck-gate-bar-text">
            <span className="action-deck-gate-kicker">{copy.kicker}</span>
            <span className="action-deck-gate-headline">{headline}</span>
          </span>
          <span className="action-deck-gate-chevron" aria-hidden="true">
            <IconChevronDown size={14} />
          </span>
        </button>
      </div>
    );
  }

  // Expanded: headline (verbatim) + primary action + collapse.
  return (
    <div
      className={cx('action-deck-gate', 'action-deck-gate--expanded', accentClass)}
      role="group"
      aria-label={copy.kicker}
      data-test="action-deck-gate"
      data-gate-kind={gate.kind}
      data-state="expanded"
    >
      <div className="action-deck-gate-header">
        <span className="action-deck-gate-glyph" aria-hidden="true">
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3l9 9-9 9-9-9 9-9z" />
          </svg>
        </span>
        <span className="action-deck-gate-kicker">{copy.kicker}</span>
        <button
          type="button"
          className="action-deck-gate-collapse"
          aria-label="Einklappen"
          title="Einklappen"
          onClick={() => setExpanded(false)}
        >
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 15l6-6 6 6" />
          </svg>
        </button>
      </div>

      {/* N1: verbatim description — CSS clamps visually, text stays complete. */}
      <p className="action-deck-gate-headline action-deck-gate-headline--full">{headline}</p>

      {isDecision && primary ? (
        // ── F18: decision with options — ONE recommended primary action +
        //    a quiet list (progressive disclosure). NO 4 equally loud buttons.
        <div className="action-deck-gate-options" data-test="action-deck-gate-options">
          <button
            type="button"
            className="action-deck-gate-cta action-deck-gate-cta--primary"
            data-test="action-deck-gate-cta"
            data-option-id={primary.id}
            data-recommended="true"
            onClick={() => onGateAction(gate, primary)}
          >
            {/* N1: verbatim label of the recommended option. */}
            <span className="action-deck-gate-cta-label">{primary.label}</span>
            {primary.sublabel ? (
              <span className="action-deck-gate-cta-sub">{primary.sublabel}</span>
            ) : null}
            <span className="action-deck-gate-cta-badge" aria-hidden="true">
              Empfohlen
            </span>
          </button>

          {secondary.length > 0 ? (
            <ul className="action-deck-gate-option-list" role="list">
              {secondary.map((opt) => (
                <li key={opt.id} role="listitem">
                  <button
                    type="button"
                    className="action-deck-gate-option"
                    data-test="action-deck-gate-option"
                    data-option-id={opt.id}
                    onClick={() => onGateAction(gate, opt)}
                  >
                    {/* N1: verbatim label. */}
                    <span className="action-deck-gate-option-label">{opt.label}</span>
                    {opt.sublabel ? (
                      <span className="action-deck-gate-option-sub">{opt.sublabel}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="action-deck-gate-freetext-hint" data-test="action-deck-gate-freetext-hint">
            Oder frei im Chat antworten.
          </p>
        </div>
      ) : (
        // ── Generic gate (live-warn/credential/connector/…): ONE CTA. ──
        <div className="action-deck-gate-actions">
          <button
            type="button"
            className="action-deck-gate-cta"
            data-test="action-deck-gate-cta"
            onClick={() => onGateAction(gate)}
          >
            {copy.cta}
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Info line (run is running) — narrow, non-blocking.
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// Resume card — an interrupted/paused workstream waits for a reaction.
// (Owner scenario „Connector-Onboarding heygen unterbrochen".)
// ───────────────────────────────────────────────────────────────────────────

export interface ActionDeckResumeProps {
  workstreamId: string;
  name: string;
  status: string;
  isOnboarding: boolean;
  /** „Fortsetzen" → delegated to the parent (single submit/resume path). */
  onResume: (workstreamId: string) => void;
}

function ActionDeckResume({
  workstreamId,
  name,
  status,
  isOnboarding,
  onResume,
}: ActionDeckResumeProps): React.JSX.Element {
  const kicker = isOnboarding ? 'Onboarding fortsetzen' : 'Fortsetzen';
  const cta = isOnboarding ? 'Onboarding fortsetzen' : 'Fortsetzen';
  return (
    <div
      className="action-deck-resume"
      role="group"
      aria-label={kicker}
      data-test="action-deck-resume"
      data-status={status}
      data-onboarding={isOnboarding ? 'true' : 'false'}
    >
      <span className="action-deck-resume-glyph" aria-hidden="true">
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 4v5h-5" />
        </svg>
      </span>
      <span className="action-deck-resume-text">
        <span className="action-deck-resume-kicker">{kicker}</span>
        {/* N1: verbatim workstream name — CSS clamps visually, text stays full. */}
        <span className="action-deck-resume-name">{name}</span>
      </span>
      <button
        type="button"
        className="action-deck-resume-cta"
        data-test="action-deck-resume-cta"
        onClick={() => onResume(workstreamId)}
      >
        {cta}
      </button>
    </div>
  );
}

function ActionDeckInfo({ phase }: { phase?: string }): React.JSX.Element {
  return (
    <div
      className="action-deck-info"
      role="status"
      data-test="action-deck-info"
      aria-label={phase ? `läuft — ${phase}` : 'läuft'}
    >
      <span className="action-deck-info-dot" aria-hidden="true" />
      <span className="action-deck-info-text">
        läuft{phase ? <> · <span className="action-deck-info-phase">{phase}</span></> : null}
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ActionDeck — the region.
// ───────────────────────────────────────────────────────────────────────────

export interface ActionDeckProps {
  /**
   * The pinned item from the DB projection (`selectPinnedItem`). Determines
   * gate vs. info. null/question → gate/info do not render (see pill below).
   */
  pinned: PinnedItem;
  /**
   * Primary gate action → delegated to the parent (single submit path).
   * F18: optional second argument = the chosen decision option (for
   * kind='decision'); the parent uses it to click the real in-feed button.
   */
  onGateAction: (gate: BlockingGateState, option?: GateOption) => void;

  /**
   * „Fortsetzen" of an interrupted/paused workstream → delegated to the parent
   * (owner scenario connector onboarding). The parent knows the
   * resume/auth path (connector/server). Optional — if the handler is missing,
   * the resume card is rendered as a non-actionable context hint.
   */
  onResume?: (workstreamId: string) => void;

  /**
   * BLOCKER 1 (2026-05-30): visible feedback instead of a silent no-op. When the
   * parent does not (yet) find the action's stream card in the DOM, it briefly
   * sets the gate.kind here — the gate region pulses (CSS) instead of doing nothing.
   * null = no miss.
   */
  actionMissKind?: string | null;

  /**
   * The open questions for the existing pill (history-driven, as today).
   * If not empty AND no gate takes precedence → pill renders (back-compat).
   */
  pillQuestions: ChatOpenQuestionsPillProps['questions'];
  /** All pill props except `questions` — 1:1 to the existing pill. */
  pillProps: Omit<ChatOpenQuestionsPillProps, 'questions'>;
}

export function ActionDeck({
  pinned,
  onGateAction,
  onResume,
  actionMissKind,
  pillQuestions,
  pillProps,
}: ActionDeckProps): React.JSX.Element | null {
  // ── (a) Gate ALWAYS takes precedence — never gate AND pill at the same time. ──────────
  if (pinned && pinned.type === 'gate') {
    const miss = actionMissKind === pinned.gate.kind;
    return (
      <div
        className="action-deck"
        data-test="action-deck"
        data-variant="gate"
        data-action-miss={miss ? pinned.gate.kind : undefined}
      >
        <ActionDeckGate gate={pinned.gate} onGateAction={onGateAction} />
      </div>
    );
  }

  // ── (b) Question path — today's pill 1:1 (fully preserved). ────────────────
  // Deliberately history-driven (pillQuestions), NOT projection-driven:
  // so the pill appears even when the projection route lags behind the live
  // question. No gate → the pill may render.
  if (pillQuestions.length > 0) {
    return (
      <div className="action-deck" data-test="action-deck" data-variant="question">
        <ChatOpenQuestionsPill questions={pillQuestions} {...pillProps} />
      </div>
    );
  }

  // ── (b2) Resume — interrupted/paused workstream waits. ─────────────
  // Owner scenario „Connector-Onboarding heygen unterbrochen": an action-
  // guiding card with the workstream name + „Fortsetzen", instead of the
  // context getting lost in a generic „läuft"/clarification menu.
  if (pinned && pinned.type === 'resume') {
    return (
      <div
        className="action-deck"
        data-test="action-deck"
        data-variant="resume"
        data-onboarding={pinned.isOnboarding ? 'true' : 'false'}
      >
        <ActionDeckResume
          workstreamId={pinned.workstreamId}
          name={pinned.name}
          status={pinned.status}
          isOnboarding={pinned.isOnboarding}
          onResume={onResume ?? (() => {})}
        />
      </div>
    );
  }

  // ── (c) Info — run is running, no user input expected. ────────────────────────
  if (pinned && pinned.type === 'info') {
    return (
      <div className="action-deck" data-test="action-deck" data-variant="info">
        <ActionDeckInfo phase={pinned.phase} />
      </div>
    );
  }

  // ── (d) Nothing to pin. ──────────────────────────────────────────────────
  return null;
}

export default ActionDeck;
