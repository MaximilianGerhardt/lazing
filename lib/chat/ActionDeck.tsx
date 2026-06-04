'use client';

/**
 * ActionDeck — Slice 2 (2026-05-30, Apple-UX Surface-Rework).
 *
 * DIE EINE gepinnte Bottom-Region über dem Composer. Ersetzt KEIN bestehendes
 * Pinning, sondern UMSCHLIESST die heutige OpenQuestionsPill: an derselben
 * DOM-Position (`composerWrapStyle`, außerhalb des Scroll-Containers), mit
 * derselben Flexbox-Pinning-Geometrie. Es gibt weiterhin GENAU EINE gepinnte
 * Region — nie zwei konkurrierende Dinge.
 *
 * Owner-Befund #1 (verbatim):
 *   „Plan-Synthese fertig + Entscheidung benötigt gleichzeitig → die
 *    Entscheidung geht komplett unter → komplett irreführend. Sowas muss
 *    immer unten über den Chat angepinnt sein, so wie mit den Fragen."
 *
 * Quelle der Wahrheit ist die DB-Projektion (`useWorkspaceState` →
 * `selectPinnedItem`), NICHT die gerenderte History. `selectPinnedItem`
 * spiegelt `deriveNextAllowedUserInput`: Gate > offene Frage > Info > null.
 *
 * Rendert je nach Priorität GENAU EINE Variante:
 *   (a) Gate → ruhige Card „◆ Entscheidung benötigt · <headline>" collapsed;
 *       Expand zeigt die primäre Aktion (≥44px). Die AKTION wird an den
 *       Parent delegiert (`onGateAction`) — derselbe Submit-Pfad wie die
 *       Stream-Card, KEIN zweites Routing im Deck (wie OpenQuestionsPill
 *       seinen Submit an ChatShell delegiert). Akzent --a-warn, bzw.
 *       --a-danger bei live-warn.
 *   (b) Frage → die BESTEHENDE ChatOpenQuestionsPill 1:1 (Back-Compat —
 *       alle Features: Nav, n/total, Optionen, Dismiss, ask-but-proceed).
 *   (c) Info → schmale nicht-blockierende „läuft"-Zeile.
 *   (d) null → die Region rendert für den Deck-Teil nichts.
 *
 * WICHTIG (ERHALTEN): Wenn die Projektion (noch) kein Gate kennt, aber die
 * History bereits offene Fragen hat, MUSS die Pille trotzdem erscheinen. Der
 * Deck entscheidet deshalb nicht allein anhand der Projektion, ob die Pille
 * rendert — er rendert die Pille immer dann, wenn `pillQuestions` nicht leer
 * ist UND kein Gate Vorrang hat. So bleibt der heutige History-getriebene
 * Fragen-Pfad voll erhalten, auch wenn die Projektions-Route mal langsamer
 * ist als der Live-Stream.
 *
 * Die Gate-Surface bleibt als VERLAUF/Beleg im Strom (N8) — nur die primäre
 * Aktion wird hier gespiegelt. Sobald via DB beantwortet (nächste Projektion),
 * verschwindet das Gate aus `blockingGates` → der Deck rutscht zur nächsten
 * Priorität.
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
// Gate-Aktions-Routing (SINGLE SUBMIT PATH) — pure + DOM-getestet.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Pro Gate-Kind: Selektor der Stream-Card · der primäre Aktions-Button in ihr ·
 * ob ein Secret nötig ist (dann NICHT auto-klicken, nur fokussieren — Vault-
 * Regel, das Secret landet NIE im Deck).
 *
 * BLOCKER 1 (Critic, 2026-05-30): die frühere Map `surface-${kind}` traf nur
 * live-warn. human-decision rendert als `surface-decision-brief`,
 * credential-request/connector-call-preview hatten gar kein `data-test` → das
 * war ein stiller No-op. Diese Map ist die korrigierte, vollständige Quelle.
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
    action: null, // Secret → nur fokussieren.
    secret: true,
  },
  'counter-evidence': {
    card: '[data-test="surface-counter-evidence"]',
    action: null, // reine Beleg-Card.
    secret: false,
  },
  // F18 (2026-05-30): die gepinnte Decision/quickchoice. Der Deck rendert die
  // Optionen selbst; eine Option-Auswahl klickt den ECHTEN Button der in-feed
  // Decision-Card (single submit path, kein zweiter fetch). Default-`action`
  // (ohne spezifische Option) → die empfohlene/primäre Option der Card.
  decision: {
    card: '[data-test="surface-decision"]',
    action: '[data-test="surface-decision-option"][data-recommended="true"]',
    secret: false,
  },
};

/**
 * F18 — Selektor für EINE bestimmte Option einer gepinnten Decision-Card. Der
 * Deck klickt damit den ECHTEN in-feed-Button (kein zweiter fetch) → exakt der
 * gleiche reply(label)-Submit-Pfad wie ein direkter Klick auf die Karte.
 */
function decisionOptionSelector(optionId: string): string {
  // Attribut-Selektor mit escaptem Wert (Option-IDs sind app-generiert, i.d.R.
  // einfache Slugs — JSON.stringify quotet defensiv für CSS-Attr-Matching).
  return `[data-test="surface-decision-option"][data-option-id=${JSON.stringify(optionId)}]`;
}

export type GateActionOutcome =
  | 'clicked' // primärer Card-Button wurde programmatisch ausgelöst (single POST)
  | 'focused' // Secret-Card: Input fokussiert, NICHT geklickt
  | 'scrolled' // sichtbar gemacht, aber keine primäre Aktion (counter-evidence)
  | 'missing'; // Card (noch) nicht im DOM → Caller zeigt sichtbares Feedback

/**
 * Führt die primäre Gate-Aktion DIREKT über die zugehörige Stream-Card aus —
 * GENAU EIN POST-Pfad (Critic-Punkt 3): der Deck baut nie einen zweiten fetch,
 * er klickt den echten Button der Card. Für Secret-Gates wird nur fokussiert.
 *
 * Reiner DOM-Effekt (kein React) → unit-testbar gegen ein injiziertes
 * `root` (Default: document). Fail-soft bei fehlendem DOM (SSR) → 'missing'.
 */
export function executeGateAction(
  gate: BlockingGateState,
  root?: Document | HTMLElement,
  /**
   * F18: für kind='decision' optional die ID der gewählten Option. Gesetzt →
   * der Deck klickt GENAU diese Option der in-feed Decision-Card; fehlt sie →
   * die empfohlene/primäre Option (entry.action). So bleibt es EIN Submit-Pfad
   * (Klick auf den echten Card-Button), egal ob Primär- oder Listen-Option.
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

  // F18: gezielte Option (Listen-Auswahl) ODER die empfohlene Primär-Aktion.
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
// Gate-Vokabular → menschenlesbares Label + primärer Aktions-Text (verbatim
// description bleibt N1-erhalten als Sub-Zeile).
// ───────────────────────────────────────────────────────────────────────────

interface GateCopy {
  /** Kicker-Label (collapsed sichtbar). */
  kicker: string;
  /** Primärer Aktions-Button-Text (expanded). */
  cta: string;
  /** true → danger-Akzent (--a-danger), sonst warn-Akzent (--a-warn). */
  danger: boolean;
}

export function gateCopy(kind: BlockingGateKind): GateCopy {
  switch (kind) {
    case 'live-warn':
      // Owner-Spec: live-warn ist die schärfste Stufe → danger-Akzent.
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
      // F18: die gepinnte Decision/quickchoice. Kicker = Owner-Vokabular
      // („Entscheidung benötigt"), CTA = die empfohlene Primär-Option (der
      // Deck überschreibt den CTA-Text mit dem verbatim Label der Primär-Option).
      return { kicker: 'Entscheidung benötigt', cta: 'Empfohlene Option', danger: false };
    default: {
      // Exhaustiv — neue Gate-Kinds müssen hier ergänzt werden.
      const _exhaustive: never = kind;
      void _exhaustive;
      return { kicker: 'Entscheidung benötigt', cta: 'Ansehen', danger: false };
    }
  }
}

/**
 * Eine knappe Überschrift für das Gate. Bevorzugt die verbatim description
 * aus dem payload (N1); fällt sonst auf das Kicker-Label zurück. KEIN .slice —
 * CSS klemmt die Anzeige (line-clamp), der Wahrheits-Text bleibt im DOM.
 */
export function gateHeadline(gate: BlockingGateState): string {
  const d = typeof gate.description === 'string' ? gate.description.trim() : '';
  if (d.length > 0) return d;
  return gateCopy(gate.kind).kicker;
}

// ───────────────────────────────────────────────────────────────────────────
// Gate-Card (collapsed/expand) — token-only, alle Farben via CSS-Klassen.
// ───────────────────────────────────────────────────────────────────────────

export interface ActionDeckGateProps {
  gate: BlockingGateState;
  /**
   * Primäre Aktion → an den Parent delegiert (single submit path). Der Parent
   * (ChatShell) besitzt den EINEN Aktions-Pfad zur Stream-Card / zum POST-
   * Handler — der Deck routet NICHT selbst. Spiegelt das Delegations-Modell
   * der OpenQuestionsPill (`onSubmitAll` lebt im Parent).
   *
   * F18: für kind='decision' kann der Deck eine konkrete Option mitgeben
   * (zweites Argument). Der Parent reicht sie an `executeGateAction(gate, root,
   * option.id)` weiter — dort wird der ECHTE in-feed-Option-Button geklickt
   * (kein zweiter fetch). Ohne Option (alte Caller) → empfohlene Primär-Aktion.
   */
  onGateAction: (gate: BlockingGateState, option?: GateOption) => void;
}

/**
 * F18 — wählt die empfohlene Primär-Option (genau eine; `extractGateOptions`
 * garantiert das) oder die erste als Fallback. Liefert undefined, wenn die
 * Decision keine Optionen trägt (dann rendert der Deck wie ein generisches Gate).
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

  // F18: eine gepinnte Decision mit Optionen rendert die Optionen + EINE
  // empfohlene Primär-Aktion (gefüllt/Akzent) + ruhige Liste. Free-Text bleibt
  // über den Composer möglich (der Deck blockiert die Eingabe nicht).
  const isDecision = gate.kind === 'decision';
  const primary = isDecision ? primaryOption(gate) : undefined;
  const secondary: GateOption[] =
    isDecision && Array.isArray(gate.options)
      ? gate.options.filter((o) => o !== primary)
      : [];

  // Collapsed: eine ruhige Zeile. ◆ + Kicker + Headline + Chevron. ≥44px Hit.
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

  // Expanded: Headline (verbatim) + primäre Aktion + Einklappen.
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

      {/* N1: verbatim description — CSS klemmt visuell, Text bleibt vollständig. */}
      <p className="action-deck-gate-headline action-deck-gate-headline--full">{headline}</p>

      {isDecision && primary ? (
        // ── F18: Decision mit Optionen — EINE empfohlene Primär-Aktion +
        //    ruhige Liste (progressive disclosure). KEINE 4 gleichlaute Buttons.
        <div className="action-deck-gate-options" data-test="action-deck-gate-options">
          <button
            type="button"
            className="action-deck-gate-cta action-deck-gate-cta--primary"
            data-test="action-deck-gate-cta"
            data-option-id={primary.id}
            data-recommended="true"
            onClick={() => onGateAction(gate, primary)}
          >
            {/* N1: verbatim Label der empfohlenen Option. */}
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
                    {/* N1: verbatim Label. */}
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
        // ── Generisches Gate (live-warn/credential/connector/…): EIN CTA. ──
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
// Info-Zeile (Run läuft) — schmal, nicht blockierend.
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// Resume-Card — ein unterbrochener/pausierter Workstream wartet auf Reaktion.
// (Owner-Szenario „Connector-Onboarding heygen unterbrochen".)
// ───────────────────────────────────────────────────────────────────────────

export interface ActionDeckResumeProps {
  workstreamId: string;
  name: string;
  status: string;
  isOnboarding: boolean;
  /** „Fortsetzen" → an den Parent delegiert (single submit/resume path). */
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
        {/* N1: verbatim Workstream-Name — CSS klemmt visuell, Text bleibt voll. */}
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
// ActionDeck — die Region.
// ───────────────────────────────────────────────────────────────────────────

export interface ActionDeckProps {
  /**
   * Das gepinnte Item aus der DB-Projektion (`selectPinnedItem`). Bestimmt
   * Gate vs. Info. null/Frage → Gate/Info rendern nicht (s. Pille unten).
   */
  pinned: PinnedItem;
  /**
   * Primäre Gate-Aktion → an den Parent delegiert (single submit path).
   * F18: optionales zweites Argument = die gewählte Decision-Option (für
   * kind='decision'); der Parent klickt damit den echten in-feed-Button.
   */
  onGateAction: (gate: BlockingGateState, option?: GateOption) => void;

  /**
   * „Fortsetzen" eines unterbrochenen/pausierten Workstreams → an den Parent
   * delegiert (Owner-Szenario Connector-Onboarding). Der Parent kennt den
   * Resume-/Auth-Pfad (Connector/Server). Optional — fehlt der Handler, wird
   * die Resume-Card als nicht-aktionierbarer Kontext-Hinweis gerendert.
   */
  onResume?: (workstreamId: string) => void;

  /**
   * BLOCKER 1 (2026-05-30): sichtbares Feedback statt stillem No-op. Wenn der
   * Parent die Stream-Card der Aktion (noch) nicht im DOM findet, setzt er den
   * gate.kind kurz hier — die Gate-Region pulst (CSS) statt nichts zu tun.
   * null = kein Miss.
   */
  actionMissKind?: string | null;

  /**
   * Die offenen Fragen für die bestehende Pille (History-getrieben, wie heute).
   * Wenn nicht leer UND kein Gate Vorrang hat → Pille rendert (Back-Compat).
   */
  pillQuestions: ChatOpenQuestionsPillProps['questions'];
  /** Alle Pillen-Props bis auf `questions` — 1:1 an die bestehende Pille. */
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
  // ── (a) Gate hat IMMER Vorrang — nie Gate UND Pille gleichzeitig. ──────────
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

  // ── (b) Frage-Pfad — die heutige Pille 1:1 (voll erhalten). ────────────────
  // Bewusst History-getrieben (pillQuestions), NICHT projektions-getrieben:
  // so erscheint die Pille auch dann, wenn die Projektions-Route der Live-
  // Frage hinterherhinkt. Kein Gate → die Pille darf rendern.
  if (pillQuestions.length > 0) {
    return (
      <div className="action-deck" data-test="action-deck" data-variant="question">
        <ChatOpenQuestionsPill questions={pillQuestions} {...pillProps} />
      </div>
    );
  }

  // ── (b2) Resume — unterbrochener/pausierter Workstream wartet. ─────────────
  // Owner-Szenario „Connector-Onboarding heygen unterbrochen": handlungs-
  // leitende Karte mit Workstream-Namen + „Fortsetzen", statt dass der
  // Kontext in einem generischen „läuft"/Klär-Menü untergeht.
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

  // ── (c) Info — Run läuft, kein User-Input erwartet. ────────────────────────
  if (pinned && pinned.type === 'info') {
    return (
      <div className="action-deck" data-test="action-deck" data-variant="info">
        <ActionDeckInfo phase={pinned.phase} />
      </div>
    );
  }

  // ── (d) Nichts zu pinnen. ──────────────────────────────────────────────────
  return null;
}

export default ActionDeck;
